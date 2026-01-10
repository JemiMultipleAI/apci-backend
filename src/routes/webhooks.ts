import { Router, Request, Response, NextFunction } from 'express';
import { createError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { authenticate, enrichUser } from '../middleware/auth';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { query, queryOne } from '../db/connection';
import { z } from 'zod';
import {
  createWebhookToken,
  validateWebhookToken,
  getWebhookTokenById,
  deactivateWebhookToken,
  generateEmailWebhookUrl,
  generateSMSWebhookUrl,
  generateReplyToEmail,
} from '../services/webhookTokens';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { processInboundMessage, processInboundMessageByContact } from '../services/inboundMessageProcessor';
import { env } from '../config/env';
import { handleMediaStreamConnection } from '../services/twilioMediaStreams';
import WebSocket from 'ws';

/**
 * Fetch email content from Resend API using email_id
 */
async function getEmailContentFromResend(emailId: string): Promise<{ text?: string; html?: string } | null> {
  try {
    const resendApiKey = env.RESEND_API_KEY;
    if (!resendApiKey) {
      logger.warn('[WEBHOOK] RESEND_API_KEY not configured, cannot fetch email content');
      return null;
    }

    // Use the receiving endpoint for inbound emails
    // See: https://resend.com/docs/api-reference/emails/retrieve-received-email
    const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error('[WEBHOOK] Failed to fetch email content from Resend', {
        emailId,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const emailData = await response.json() as { text?: string; body?: string; html?: string };
    logger.info('[WEBHOOK] Successfully fetched email content from Resend', {
      emailId,
      hasText: !!emailData.text,
      hasHtml: !!emailData.html,
    });
    
    return {
      text: emailData.text || emailData.body,
      html: emailData.html,
    };
  } catch (error: any) {
    logger.error('[WEBHOOK] Error fetching email content from Resend', {
      emailId,
      error: error.message,
    });
    return null;
  }
}

const router = Router();

/**
 * POST /api/webhooks/tokens - Create a new webhook token
 */
router.post('/tokens', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const schema = z.object({
      campaign_id: z.string().uuid().optional().nullable(),
      contact_id: z.string().uuid().optional().nullable(),
      activity_id: z.string().uuid().optional().nullable(),
      type: z.enum(['email', 'sms', 'both']),
      expires_in_days: z.number().optional(),
    });

    const validatedData = schema.parse(req.body);

    // Get user's company ID
    const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
    if (!userCompanyId && !isSuperAdmin(req.user)) {
      return next(createError('User must be associated with a company', 400));
    }

    // Validate company access for campaign/contact if provided
    if (validatedData.campaign_id && !isSuperAdmin(req.user)) {
      const campaign = await queryOne<{ created_by: string | null }>(
        'SELECT created_by FROM campaigns WHERE id = $1',
        [validatedData.campaign_id]
      );
      if (campaign?.created_by) {
        const creator = await queryOne<{ account_id: string | null }>(
          'SELECT account_id FROM users WHERE id = $1',
          [campaign.created_by]
        );
        if (creator?.account_id !== userCompanyId) {
          return next(createError('Forbidden: You do not have access to this campaign', 403));
        }
      }
    }

    if (validatedData.contact_id && !isSuperAdmin(req.user)) {
      const contact = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM contacts WHERE id = $1',
        [validatedData.contact_id]
      );
      if (contact?.account_id !== userCompanyId) {
        return next(createError('Forbidden: You do not have access to this contact', 403));
      }
    }

    // Calculate expiration date
    let expiresAt: Date | null = null;
    if (validatedData.expires_in_days) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + validatedData.expires_in_days);
    }

    const token = await createWebhookToken({
      account_id: userCompanyId || '',
      campaign_id: validatedData.campaign_id || null,
      contact_id: validatedData.contact_id || null,
      activity_id: validatedData.activity_id || null,
      type: validatedData.type,
      expires_at: expiresAt,
      created_by: req.user.userId,
    });

    // Generate webhook URLs
    const emailUrl = (validatedData.type === 'email' || validatedData.type === 'both')
      ? generateEmailWebhookUrl(token.token)
      : null;
    const smsUrl = (validatedData.type === 'sms' || validatedData.type === 'both')
      ? generateSMSWebhookUrl(token.token)
      : null;
    const replyToEmail = (validatedData.type === 'email' || validatedData.type === 'both')
      ? generateReplyToEmail(token.token)
      : null;

    res.status(201).json({
      success: true,
      data: {
        ...token,
        webhook_urls: {
          email: emailUrl,
          sms: smsUrl,
          reply_to_email: replyToEmail,
        },
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map(e => e.message).join(', '), 400));
    }
    next(error);
  }
});

/**
 * GET /api/webhooks/tokens - List webhook tokens (company-scoped)
 */
router.get('/tokens', authenticate, enrichUser, applyCompanyFilter('wt'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '20', campaign_id, contact_id, is_active } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let whereClause = 'WHERE 1=1';
    const params: (string | number | boolean)[] = [];
    let paramIndex = 1;

    // Apply company filter
    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` ${req.companyFilter.clause.replace('account_id', 'wt.account_id')}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    if (campaign_id) {
      const campaignIdStr = Array.isArray(campaign_id) ? campaign_id[0] : campaign_id;
      if (typeof campaignIdStr === 'string') {
        const uuidSchema = z.string().uuid();
        if (uuidSchema.safeParse(campaignIdStr).success) {
          whereClause += ` AND wt.campaign_id = $${paramIndex}`;
          params.push(campaignIdStr);
          paramIndex++;
        }
      }
    }

    if (contact_id) {
      const contactIdStr = Array.isArray(contact_id) ? contact_id[0] : contact_id;
      if (typeof contactIdStr === 'string') {
        const uuidSchema = z.string().uuid();
        if (uuidSchema.safeParse(contactIdStr).success) {
          whereClause += ` AND wt.contact_id = $${paramIndex}`;
          params.push(contactIdStr);
          paramIndex++;
        }
      }
    }

    if (is_active !== undefined) {
      const isActiveValue = Array.isArray(is_active) ? is_active[0] : is_active;
      let isActive: boolean;
      if (typeof isActiveValue === 'boolean') {
        isActive = isActiveValue;
      } else if (typeof isActiveValue === 'string') {
        isActive = isActiveValue === 'true' || isActiveValue === '1';
      } else {
        isActive = false;
      }
      whereClause += ` AND wt.is_active = $${paramIndex}`;
      params.push(isActive);
      paramIndex++;
    }

    const tokens = await query(
      `SELECT 
        wt.*,
        c.name as campaign_name,
        con.first_name || ' ' || con.last_name as contact_name,
        con.email as contact_email
       FROM webhook_tokens wt
       LEFT JOIN campaigns c ON wt.campaign_id = c.id
       LEFT JOIN contacts con ON wt.contact_id = con.id
       ${whereClause}
       ORDER BY wt.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM webhook_tokens wt ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: tokens,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: parseInt(countResult?.count || '0'),
      },
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * DELETE /api/webhooks/tokens/:token - Deactivate a webhook token
 */
router.delete('/tokens/:token', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { token } = req.params;

    // Get token to check company access
    const tokenData = await validateWebhookToken(token);
    if (!tokenData) {
      return next(createError('Webhook token not found or inactive', 404));
    }

    // Check company access
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (tokenData.account_id !== userCompanyId) {
        return next(createError('Forbidden: You do not have access to this token', 403));
      }
    }

    await deactivateWebhookToken(token);

    res.json({
      success: true,
      message: 'Webhook token deactivated successfully',
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/webhooks/inbound/email/:token - Receive inbound email reply
 */
router.post('/inbound/email/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    logger.info('[WEBHOOK] Inbound email received (token-based)', {
      token: token.substring(0, 8) + '...',
      contentType: req.headers['content-type'],
    });

    // Validate token
    const tokenData = await validateWebhookToken(token);
    if (!tokenData) {
      logger.warn('[WEBHOOK] Invalid webhook token for inbound email', {
        token: token.substring(0, 8) + '...',
      });
      return res.status(404).json({ success: false, error: 'Invalid or expired token' });
    }

    // Log full payload for debugging
    logger.info('[WEBHOOK] Full email payload (token-based)', {
      fullPayload: JSON.stringify(req.body, null, 2),
      payloadKeys: Object.keys(req.body || {}),
      hasData: !!req.body.data,
      dataKeys: req.body.data ? Object.keys(req.body.data) : [],
      contentType: req.headers['content-type'],
    });

    // Extract email data from request (handle different provider formats)
    // Resend format: { data: { from, to, subject, text, html, ... }, type, created_at }
    // SendGrid format: { envelope, headers, text, html, ... }
    // Direct format: { from, to, subject, text, html, headers }
    // Try multiple field name variations and nested structures
    const data = req.body.data || req.body;
    
    const from = data.from || req.body.from || req.body.sender || req.body['from'] || 
                 req.body.envelope?.from || 
                 req.body.headers?.['from'] || req.body.headers?.['From'] ||
                 req.body.headers?.['return-path'] || req.body.headers?.['Return-Path'];
    
    // Handle 'to' as array or string
    const toRaw = data.to || req.body.to || req.body.recipient || req.body['to'] ||
                  req.body.envelope?.to?.[0] ||
                  req.body.headers?.['to'] || req.body.headers?.['To'];
    const to = Array.isArray(toRaw) ? toRaw[0] : toRaw;
    
    const subject = data.subject || req.body.subject || req.body['subject'] ||
                    req.body.headers?.['subject'] || req.body.headers?.['Subject'] ||
                    req.body.headers?.['subject']?.[0];
    
    const text = data.text || data.body || req.body.text || req.body.body || req.body['text'] || req.body['body'];
    const html = data.html || req.body.html || req.body['html'];
    const headers = data.headers || req.body.headers || req.body['headers'] || {};

    logger.info('[WEBHOOK] Extracted email fields (token-based)', {
      from,
      to,
      subject,
      hasText: !!text,
      hasHtml: !!html,
      textPreview: text ? text.substring(0, 200) : null,
      htmlPreview: html ? html.substring(0, 200) : null,
      dataObject: data ? {
        keys: Object.keys(data),
        hasText: !!data.text,
        hasBody: !!data.body,
        hasHtml: !!data.html,
      } : null,
    });

    if (!from || !subject) {
      logger.error('[WEBHOOK] Missing required email fields (token-based)', {
        receivedFields: Object.keys(req.body),
        from: !!from,
        subject: !!subject,
        bodySample: JSON.stringify(req.body).substring(0, 500),
      });
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required email fields (from, subject)',
        receivedFields: Object.keys(req.body),
      });
    }

    // Find or create contact by email
    let contactId = tokenData.contact_id;
    if (!contactId) {
      const contact = await queryOne<{ id: string }>(
        'SELECT id FROM contacts WHERE email = $1 AND account_id = $2 LIMIT 1',
        [from, tokenData.account_id]
      );
      contactId = contact?.id || null;
    }

    // Extract email_id to fetch content from Resend
    const emailId = data.email_id || req.body.email_id;
    
    // Try to get email content from Resend if we have email_id
    let emailContent: { text?: string; html?: string } | null = null;
    if (emailId) {
      logger.info('[WEBHOOK] Fetching email content from Resend', { emailId });
      emailContent = await getEmailContentFromResend(emailId);
    }

    // Use fetched content if available, otherwise fall back to extracted text/html
    const finalText = emailContent?.text || text || html?.replace(/<[^>]*>/g, '') || null;
    const finalHtml = emailContent?.html || html || null;

    // Create activity record for the inbound message
    const activityDescription = finalText || 'Email reply received';
    const activityMetadata = {
      webhook_token_id: tokenData.id,
      original_campaign_id: tokenData.campaign_id,
      original_activity_id: tokenData.activity_id,
      email_from: from,
      email_to: to,
      email_subject: subject,
      email_headers: headers || {},
      inbound: true,
    };

    await queryOne<{ id: string }>(
      `INSERT INTO activities (
        type, subject, description, related_to_type, related_to_id, metadata, account_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [
        'email',
        `Reply: ${subject}`,
        activityDescription,
        'contact',
        contactId,
        JSON.stringify(activityMetadata),
        tokenData.account_id,
      ]
    );

    // Process message through ElevenLabs agent and send response (async)
    const messageId = data.message_id || req.body.message_id || 
                      headers?.['message-id'] || headers?.['Message-ID'] ||
                      data.email_id || req.body.email_id;
    
    processInboundMessage({
      token,
      messageBody: finalText || activityDescription,
      senderEmail: from,
      channel: 'email',
      metadata: {
        subject,
        to,
        headers,
        message_id: messageId,
      },
    }).catch(error => {
      logger.error('Failed to process inbound email through agent', {
        error: error.message,
        tokenId: tokenData.id,
        contactId,
      });
    });

    // Return success immediately (processing is async)
    res.status(200).json({ success: true, message: 'Email reply received and processing' });
  } catch (error: any) {
    logger.error('Failed to process inbound email', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/webhooks/inbound/email - Receive inbound email reply (configured in email provider dashboard)
 * This endpoint looks up contacts by email address and tries to find tokens from recent activities
 */
router.post('/inbound/email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Log full payload for debugging
    logger.info('[WEBHOOK] Full email payload (dashboard webhook)', {
      fullPayload: JSON.stringify(req.body, null, 2),
      payloadKeys: Object.keys(req.body || {}),
      hasData: !!req.body.data,
      dataKeys: req.body.data ? Object.keys(req.body.data) : [],
      contentType: req.headers['content-type'],
    });

    // Extract email data from request (handle different provider formats)
    // Resend format: { data: { from, to, subject, text, html, ... }, type, created_at }
    // SendGrid format: { envelope, headers, text, html, ... }
    // Direct format: { from, to, subject, text, html, headers }
    // Try multiple field name variations and nested structures
    const data = req.body.data || req.body;
    
    const from = data.from || req.body.from || req.body.sender || req.body['from'] || 
                 req.body.envelope?.from || 
                 req.body.headers?.['from'] || req.body.headers?.['From'] ||
                 req.body.headers?.['return-path'] || req.body.headers?.['Return-Path'];
    
    // Handle 'to' as array or string
    const toRaw = data.to || req.body.to || req.body.recipient || req.body['to'] ||
                  req.body.envelope?.to?.[0] ||
                  req.body.headers?.['to'] || req.body.headers?.['To'];
    const to = Array.isArray(toRaw) ? toRaw[0] : toRaw;
    
    const subject = data.subject || req.body.subject || req.body['subject'] ||
                    req.body.headers?.['subject'] || req.body.headers?.['Subject'] ||
                    req.body.headers?.['subject']?.[0];
    
    const text = data.text || data.body || req.body.text || req.body.body || req.body['text'] || req.body['body'];
    const html = data.html || req.body.html || req.body['html'];
    const headers = data.headers || req.body.headers || req.body['headers'] || {};

    logger.info('[WEBHOOK] Extracted email fields', {
      from,
      to,
      subject,
      hasText: !!text,
      hasHtml: !!html,
      textPreview: text ? text.substring(0, 200) : null,
      htmlPreview: html ? html.substring(0, 200) : null,
      receivedFields: Object.keys(req.body),
      dataObject: data ? {
        keys: Object.keys(data),
        hasText: !!data.text,
        hasBody: !!data.body,
        hasHtml: !!data.html,
      } : null,
    });

    if (!from || !subject) {
      logger.error('[WEBHOOK] Missing required email fields', {
        receivedFields: Object.keys(req.body),
        from: !!from,
        subject: !!subject,
        bodySample: JSON.stringify(req.body).substring(0, 500),
      });
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required email fields (from, subject)',
        receivedFields: Object.keys(req.body),
      });
    }

    // Find contact by email address across all companies
    const contact = await queryOne<{
      id: string;
      account_id: string;
      first_name: string;
      last_name: string;
    }>(
      `SELECT c.id, c.account_id, c.first_name, c.last_name
       FROM contacts c
       WHERE c.email = $1
       LIMIT 1`,
      [from]
    );

    if (!contact) {
      logger.warn('[WEBHOOK] Contact not found for email address', { from });
      // Still return 200 to email provider (don't want to retry)
      return res.status(200).json({ success: false, message: 'Contact not found' });
    }

    // Extract email_id to fetch content from Resend
    const emailId = data.email_id || req.body.email_id;
    
    // Try to get email content from Resend if we have email_id
    let emailContent: { text?: string; html?: string } | null = null;
    if (emailId) {
      logger.info('[WEBHOOK] Fetching email content from Resend', { emailId });
      emailContent = await getEmailContentFromResend(emailId);
    }

    // Use fetched content if available, otherwise fall back to extracted text/html
    const finalText = emailContent?.text || text || html?.replace(/<[^>]*>/g, '') || null;
    const finalHtml = emailContent?.html || html || null;

    // Try to find webhook token from the most recent outbound email activity
    const recentActivity = await queryOne<{
      campaign_id: string | null;
      activity_id: string;
      webhook_token: string | null;
    }>(
      `SELECT a.id as activity_id,
              COALESCE(
                (a.metadata->>'original_campaign_id')::uuid,
                (a.metadata->>'campaign_id')::uuid
              ) as campaign_id,
              a.metadata->>'webhook_token' as webhook_token
       FROM activities a
       WHERE a.related_to_id = $1
         AND a.related_to_type = 'contact'
         AND a.type = 'email'
         AND a.metadata->>'inbound' IS NULL
         AND a.metadata->>'webhook_token' IS NOT NULL
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [contact.id]
    );

    let campaignId: string | null = null;
    let token: string | null = null;
    let tokenData: any = null;

    // If we found a token in recent activity, validate and use it
    if (recentActivity?.webhook_token) {
      token = recentActivity.webhook_token;
      tokenData = await validateWebhookToken(token);
      if (tokenData) {
        campaignId = tokenData.campaign_id || recentActivity.campaign_id;
        logger.info('[WEBHOOK] Found valid webhook token from recent activity', {
          token: token.substring(0, 8) + '...',
          campaignId,
          contactId: contact.id,
        });
      } else {
        logger.warn('[WEBHOOK] Token from activity is invalid or expired', {
          token: token.substring(0, 8) + '...',
        });
        // Fall back to campaign_id from activity
        campaignId = recentActivity.campaign_id;
      }
    } else {
      // Fall back to campaign_id from activity metadata
      campaignId = recentActivity?.campaign_id || null;
    }

    // Create activity record for the inbound message
    const activityDescription = finalText || 'Email reply received';
    const activityMetadata: any = {
      email_from: from,
      email_to: to,
      email_subject: subject,
      email_headers: headers || {},
      inbound: true,
      raw_webhook_payload: req.body,
    };

    if (tokenData) {
      activityMetadata.webhook_token_id = tokenData.id;
      activityMetadata.webhook_token = token;
      activityMetadata.original_campaign_id = tokenData.campaign_id;
      activityMetadata.original_activity_id = tokenData.activity_id;
    } else if (campaignId) {
      activityMetadata.original_campaign_id = campaignId;
      if (recentActivity) {
        activityMetadata.original_activity_id = recentActivity.activity_id;
      }
    }

    const activity = await queryOne<{ id: string }>(
      `INSERT INTO activities (
        type, subject, description, related_to_type, related_to_id, metadata, account_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [
        'email',
        `Reply: ${subject}`,
        activityDescription,
        'contact',
        contact.id,
        JSON.stringify(activityMetadata),
        contact.account_id,
      ]
    );

    // Process message through ElevenLabs agent
    // Use token-based processing if we have a valid token, otherwise use contact-based
    const messageId = data.message_id || req.body.message_id || 
                      headers?.['message-id'] || headers?.['Message-ID'] ||
                      data.email_id || req.body.email_id;
    
    if (tokenData && token) {
      processInboundMessage({
        token,
        messageBody: activityDescription,
        senderEmail: from,
        channel: 'email',
        metadata: {
          subject,
          to,
          headers,
          message_id: messageId,
          activity_id: activity?.id,
        },
      }).catch((error: any) => {
        logger.error('Failed to process inbound email through agent (token-based)', {
          error: error.message,
          tokenId: tokenData.id,
          contactId: contact.id,
        });
      });
    } else {
      processInboundMessageByContact({
        contactId: contact.id,
        accountId: contact.account_id,
        campaignId,
        messageBody: finalText || activityDescription,
        senderEmail: from,
        channel: 'email',
        metadata: {
          subject,
          to,
          headers,
          message_id: messageId,
          activity_id: activity?.id,
        },
      }).catch((error: any) => {
        logger.error('Failed to process inbound email through agent (contact-based)', {
          error: error.message,
          contactId: contact.id,
          campaignId,
        });
      });
    }

    // Return success immediately (processing is async)
    res.status(200).json({ success: true, message: 'Email reply received and processing' });
  } catch (error: any) {
    logger.error('[WEBHOOK] Failed to process inbound email', { error: error.message, stack: error.stack });
    // Still return 200 to email provider to prevent retries
    res.status(200).json({ success: false, error: 'Internal error processing email' });
  }
});

/**
 * POST /api/webhooks/inbound/sms/:token - Receive inbound SMS reply with token (for per-message webhooks)
 * This endpoint uses the token to get direct campaign/contact context
 */
router.post('/inbound/sms/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    logger.info('[WEBHOOK] Inbound SMS received (token-based)', {
      token: token.substring(0, 8) + '...',
      from: req.body.From,
      to: req.body.To,
      bodyLength: req.body.Body?.length || 0,
    });

    // Validate token
    const tokenData = await validateWebhookToken(token);
    if (!tokenData) {
      logger.warn('[WEBHOOK] Invalid webhook token for inbound SMS', {
        token: token.substring(0, 8) + '...',
        from: req.body.From,
      });
      return res.status(404).json({ success: false, error: 'Invalid or expired token' });
    }

    // Extract SMS data from Twilio webhook
    const { From, To, Body, MessageSid } = req.body;

    if (!From || !To || !Body) {
      return res.status(400).json({ success: false, error: 'Missing required SMS fields (From, To, Body)' });
    }

    // Find or create contact by phone number (use token's contact_id if available)
    let contactId = tokenData.contact_id;
    if (!contactId) {
      // Normalize phone: remove all non-digits, then remove leading 1 if present
      const normalizedPhone = From.replace(/[^0-9]/g, '').replace(/^1/, '');
      const contact = await queryOne<{ id: string }>(
        `SELECT id FROM contacts 
         WHERE account_id = $1 
         AND regexp_replace(regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g'), '^1', '') = $2
         LIMIT 1`,
        [tokenData.account_id, normalizedPhone]
      );
      contactId = contact?.id || null;
    }

    // Create activity record for the inbound message
    const activityMetadata: any = {
      webhook_token_id: tokenData.id,
      webhook_token: token,
      original_campaign_id: tokenData.campaign_id,
      original_activity_id: tokenData.activity_id,
      sms_from: From,
      sms_to: To,
      message_sid: MessageSid,
      inbound: true,
      raw_webhook_payload: req.body,
    };

    const activity = await queryOne<{ id: string }>(
      `INSERT INTO activities (
        type, subject, description, related_to_type, related_to_id, metadata, account_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [
        'sms',
        'SMS Reply Received',
        Body,
        'contact',
        contactId,
        JSON.stringify(activityMetadata),
        tokenData.account_id,
      ]
    );

    // Process message through ElevenLabs agent using token context
    processInboundMessage({
      token,
      messageBody: Body,
      senderPhone: From,
      channel: 'sms',
      metadata: {
        to: To,
        message_sid: MessageSid,
        activity_id: activity?.id,
      },
    }).catch((error: any) => {
      logger.error('Failed to process inbound SMS through agent', {
        error: error.message,
        tokenId: tokenData.id,
        contactId,
      });
    });

    // Return success immediately (processing is async)
    res.status(200).json({ success: true, message: 'SMS reply received and processing' });
  } catch (error: any) {
    logger.error('[WEBHOOK] Failed to process inbound SMS (token-based)', { error: error.message, stack: error.stack });
    next(error);
  }
});

/**
 * POST /api/webhooks/inbound/sms - Receive inbound SMS reply (configured in Twilio dashboard)
 * This endpoint looks up contacts by phone number and tries to find tokens from recent activities
 */
router.post('/inbound/sms', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Extract SMS data from Twilio webhook
    const { From, To, Body, MessageSid } = req.body;

    logger.info('[WEBHOOK] Inbound SMS received (dashboard webhook)', {
      from: From,
      to: To,
      bodyLength: Body?.length || 0,
      messageSid: MessageSid,
    });

    if (!From || !To || !Body) {
      return res.status(400).json({ success: false, error: 'Missing required SMS fields (From, To, Body)' });
    }

    // Normalize phone number: remove all non-digits, then remove leading 1 if present
    const normalizedPhone = From.replace(/[^0-9]/g, '').replace(/^1/, '');

    // Find contact by phone number across all companies
    const contact = await queryOne<{
      id: string;
      account_id: string;
      first_name: string;
      last_name: string;
    }>(
      `SELECT c.id, c.account_id, c.first_name, c.last_name
       FROM contacts c
       WHERE regexp_replace(regexp_replace(COALESCE(c.mobile, ''), '[^0-9]', '', 'g'), '^1', '') = $1
       LIMIT 1`,
      [normalizedPhone]
    );

    if (!contact) {
      logger.warn('[WEBHOOK] Contact not found for phone number', { from: From, normalizedPhone });
      // Still return 200 to Twilio (don't want to retry)
      return res.status(200).json({ success: false, message: 'Contact not found' });
    }

    // Try to find webhook token from the most recent outbound SMS activity
    const recentActivity = await queryOne<{
      campaign_id: string | null;
      activity_id: string;
      webhook_token: string | null;
    }>(
      `SELECT a.id as activity_id,
              COALESCE(
                (a.metadata->>'original_campaign_id')::uuid,
                (a.metadata->>'campaign_id')::uuid
              ) as campaign_id,
              a.metadata->>'webhook_token' as webhook_token
       FROM activities a
       WHERE a.related_to_id = $1
         AND a.related_to_type = 'contact'
         AND a.type = 'sms'
         AND a.metadata->>'inbound' IS NULL
         AND a.metadata->>'webhook_token' IS NOT NULL
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [contact.id]
    );

    let campaignId: string | null = null;
    let token: string | null = null;
    let tokenData: any = null;

    // If we found a token in recent activity, validate and use it
    if (recentActivity?.webhook_token) {
      token = recentActivity.webhook_token;
      tokenData = await validateWebhookToken(token);
      if (tokenData) {
        campaignId = tokenData.campaign_id || recentActivity.campaign_id;
        logger.info('[WEBHOOK] Found valid webhook token from recent activity', {
          token: token.substring(0, 8) + '...',
          campaignId,
          contactId: contact.id,
        });
      } else {
        logger.warn('[WEBHOOK] Token from activity is invalid or expired', {
          token: token.substring(0, 8) + '...',
        });
        // Fall back to campaign_id from activity
        campaignId = recentActivity.campaign_id;
      }
    } else {
      // Fall back to campaign_id from activity metadata
      campaignId = recentActivity?.campaign_id || null;
    }

    // Create activity record for the inbound message
    const activityMetadata: any = {
      sms_from: From,
      sms_to: To,
      message_sid: MessageSid,
      inbound: true,
      raw_webhook_payload: req.body,
    };

    if (tokenData) {
      activityMetadata.webhook_token_id = tokenData.id;
      activityMetadata.webhook_token = token;
      activityMetadata.original_campaign_id = tokenData.campaign_id;
      activityMetadata.original_activity_id = tokenData.activity_id;
    } else if (campaignId) {
      activityMetadata.original_campaign_id = campaignId;
      if (recentActivity) {
        activityMetadata.original_activity_id = recentActivity.activity_id;
      }
    }

    const activity = await queryOne<{ id: string }>(
      `INSERT INTO activities (
        type, subject, description, related_to_type, related_to_id, metadata, account_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [
        'sms',
        'SMS Reply Received',
        Body,
        'contact',
        contact.id,
        JSON.stringify(activityMetadata),
        contact.account_id,
      ]
    );

    // Process message through ElevenLabs agent
    // Use token-based processing if we have a valid token, otherwise use contact-based
    if (tokenData && token) {
      processInboundMessage({
        token,
        messageBody: Body,
        senderPhone: From,
        channel: 'sms',
        metadata: {
          to: To,
          message_sid: MessageSid,
          activity_id: activity?.id,
        },
      }).catch((error: any) => {
        logger.error('Failed to process inbound SMS through agent (token-based)', {
          error: error.message,
          tokenId: tokenData.id,
          contactId: contact.id,
        });
      });
    } else {
      processInboundMessageByContact({
        contactId: contact.id,
        accountId: contact.account_id,
        campaignId,
        messageBody: Body,
        senderPhone: From,
        channel: 'sms',
        metadata: {
          to: To,
          message_sid: MessageSid,
          activity_id: activity?.id,
        },
      }).catch((error: any) => {
        logger.error('Failed to process inbound SMS through agent (contact-based)', {
          error: error.message,
          contactId: contact.id,
          campaignId,
        });
      });
    }

    // Return success immediately (processing is async)
    res.status(200).json({ success: true, message: 'SMS reply received and processing' });
  } catch (error: any) {
    logger.error('[WEBHOOK] Failed to process inbound SMS', { error: error.message, stack: error.stack });
    // Still return 200 to Twilio to prevent retries
    res.status(200).json({ success: false, error: 'Internal error processing SMS' });
  }
});

// Export function to setup WebSocket server for Media Streams
// This needs to be called from the main server file
export function setupMediaStreamsWebSocket(server: any): void {
  try {
    const wss = new WebSocket.Server({
      server,
      path: '/api/webhooks/twilio/media-streams',
      clientTracking: true, // Track connected clients for debugging
      perMessageDeflate: false, // Disable compression for better performance with audio
      verifyClient: (info: any) => {
      // Extract query parameters from the full URL (available in verifyClient)
      const fullUrl = info.req.url || '';
      let queryParams: Record<string, string> = {};
      
      try {
        const url = new URL(fullUrl, `http://${info.req.headers.host || 'localhost'}`);
        url.searchParams.forEach((value, key) => {
          queryParams[key] = value;
        });
      } catch (error) {
        // URL parsing failed, try manual parsing
        const queryString = fullUrl.split('?')[1];
        if (queryString) {
          queryString.split('&').forEach((param: string) => {
            const [key, value] = param.split('=');
            if (key && value) {
              queryParams[decodeURIComponent(key)] = decodeURIComponent(value);
            }
          });
        }
      }

      // Attach query parameters to request object for later use
      (info.req as any).__customParameters = queryParams;

      // Log all connection attempts (even failed ones) to help debug
      logger.info('[MEDIA_STREAM] WebSocket connection attempt', {
        origin: info.origin,
        secure: info.secure,
        reqUrl: info.req.url,
        queryParams: Object.keys(queryParams).length > 0 ? queryParams : 'none',
        headers: {
          'user-agent': info.req.headers['user-agent'],
          'upgrade': info.req.headers.upgrade,
          'connection': info.req.headers.connection,
        },
      });
      return true; // Accept all connections
    },
  });

  wss.on('connection', (ws: WebSocket, req: any) => {
    // Retrieve query parameters attached in verifyClient
    const customParameters = (req as any).__customParameters || {};
    
    logger.info('[MEDIA_STREAM] New WebSocket connection established', {
      url: req.url,
      customParameters: Object.keys(customParameters).length > 0 ? customParameters : 'none',
      headers: {
        'user-agent': req.headers['user-agent'],
        'origin': req.headers.origin,
      },
    });
    
    // Attach to req for use in handleMediaStreamConnection
    (req as any).customParameters = customParameters;
    handleMediaStreamConnection(ws, req);
  });

  wss.on('error', (error: Error) => {
    logger.error('[MEDIA_STREAM] WebSocket server error', {
      error: error.message,
      stack: error.stack,
    });
  });

  // Log when HTTP server is listening (WebSocket will be ready)
  server.on('listening', () => {
    logger.info('[MEDIA_STREAM] WebSocket server ready on /api/webhooks/twilio/media-streams', {
      address: server.address(),
      path: '/api/webhooks/twilio/media-streams',
    });
  });

  logger.info('[MEDIA_STREAM] WebSocket server initialized and ready');
  } catch (error: any) {
    logger.error('[MEDIA_STREAM] Failed to setup WebSocket server', {
      error: error.message,
      stack: error.stack,
    });
    // Don't throw - allow server to start even if WebSocket setup fails
    // This prevents the entire server from crashing
    console.error('⚠️  WebSocket server setup failed, but continuing server startup');
  }
}

export default router;

