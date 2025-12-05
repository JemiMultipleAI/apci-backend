import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { sendEmailFromTemplate, EmailResult } from '../services/email';
import { sendSMSFromTemplate, SMSResult } from '../services/sms';
import { makeVoiceCallFromTemplate, VoiceCallResult } from '../services/voice';
import { findDormantContacts } from '../services/subscriptionReactivation';
import { logger } from '../utils/logger';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { env } from '../config/env';
import { createWebhookToken, generateReplyToEmail, generateSMSWebhookUrl, generateEmailWebhookUrl, getOrCreateCampaignWebhookToken } from '../services/webhookTokens';
import { updateKnowledgeBaseDocument } from '../services/elevenlabsKnowledgeBase';

const router = Router();

/**
 * Helper function to refresh knowledge base for a company after campaign changes
 * This is called asynchronously and errors are logged but don't fail the request
 */
async function refreshCompanyKnowledgeBase(accountId: string | null): Promise<void> {
  if (!accountId) {
    return;
  }

  try {
    // Find the company's AI agent config
    const agentConfig = await queryOne<{
      id: string;
      name: string;
      kb_campaigns_document_id: string | null;
    }>(
      `SELECT id, name, kb_campaigns_document_id
       FROM ai_agent_configurations
       WHERE account_id = $1
       AND is_active = true
       AND kb_campaigns_document_id IS NOT NULL
       LIMIT 1`,
      [accountId]
    );

    if (!agentConfig || !agentConfig.kb_campaigns_document_id) {
      // No active agent config with KB document configured
      return;
    }

    // Update the campaigns knowledge base document with latest data
    await updateKnowledgeBaseDocument({
      documentationId: agentConfig.kb_campaigns_document_id,
      companyId: accountId,
      type: 'campaigns',
      displayName: `${agentConfig.name} - Campaigns Knowledge Base`,
    });

    logger.info('[CAMPAIGN] Knowledge base refreshed after campaign change', {
      accountId,
      agentConfigId: agentConfig.id,
    });
  } catch (error: any) {
    // Log error but don't fail the campaign operation
    logger.warn('[CAMPAIGN] Failed to refresh knowledge base', {
      accountId,
      error: error.message,
    });
  }
}

const createCampaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  type: z.enum(['reactivation', 'marketing', 'survey']),
  channel: z.enum(['email', 'sms', 'call', 'multi']),
  status: z.enum(['draft', 'scheduled', 'running', 'paused', 'completed']).optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.any()).optional(),
});

// GET /api/campaigns - List all campaigns
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10', type, channel, status } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // Apply company filtering for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId) {
        whereClause += ` AND EXISTS (
          SELECT 1 FROM users u 
          WHERE u.id = c.created_by 
          AND u.account_id = $${paramIndex}
        )`;
        params.push(userCompanyId);
        paramIndex++;
      }
    }

    if (type) {
      whereClause += ` AND c.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (channel) {
      whereClause += ` AND c.channel = $${paramIndex}`;
      params.push(channel);
      paramIndex++;
    }

    if (status) {
      whereClause += ` AND c.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    const campaigns = await query(
      `SELECT c.*, 
        u.first_name || ' ' || u.last_name as created_by_name
       FROM campaigns c
       LEFT JOIN users u ON c.created_by = u.id
       ${whereClause} 
       ORDER BY c.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM campaigns c ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: campaigns,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        totalPages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/campaigns/:id - Get single campaign
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    const campaign = await queryOne<{
      id: string;
      name: string;
      description: string | null;
      type: string;
      channel: string;
      status: string;
      created_by: string | null;
      account_id: string | null;
      metadata: any;
      start_date: Date | null;
      end_date: Date | null;
      created_at: Date;
      updated_at: Date;
      created_by_name: string | null;
    }>(
      `SELECT c.*, 
        u.first_name || ' ' || u.last_name as created_by_name
       FROM campaigns c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = $1`,
      [id]
    );

    if (!campaign) {
      throw createError('Campaign not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && campaign.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [campaign.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Campaign access denied', { userId: req.user.userId, campaignId: id, creatorAccountId: creator.account_id, userCompanyId });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    // Generate webhook URL information with actual tokens based on campaign channel
    const webhookUrls: Record<string, string> = {};
    // Use PUBLIC_WEBHOOK_URL for SMS (Twilio requires public URL), API_BASE_URL for email display
    const publicBaseUrl = env.PUBLIC_WEBHOOK_URL || env.API_BASE_URL || 'http://localhost:3001';
    const displayBaseUrl = env.API_BASE_URL || 'http://localhost:3001';
    
    // Get the account_id for the campaign (from the creator's company)
    let accountId: string | null = null;
    if (campaign.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [campaign.created_by]
      );
      accountId = creator?.account_id || null;
    }

    // Only generate tokens if we have an account_id
    if (accountId) {
      if (campaign.channel === 'email' || campaign.channel === 'multi') {
        const emailWebhookUrl = env.PUBLIC_WEBHOOK_URL || displayBaseUrl;
        
        // Recommended: Non-token endpoint for email provider dashboard configuration
        webhookUrls.email_provider = `${emailWebhookUrl}/api/webhooks/inbound/email`;
        if (emailWebhookUrl.includes('localhost') || emailWebhookUrl.includes('127.0.0.1')) {
          webhookUrls.email_provider_note = '⚠️ WARNING: This URL uses localhost. Email providers cannot reach localhost URLs. Set PUBLIC_WEBHOOK_URL environment variable to your public domain (e.g., https://yourdomain.com) and configure this URL in your email provider (Resend/SendGrid) dashboard.';
        } else {
          webhookUrls.email_provider_note = 'Copy this URL and configure it in your email provider (Resend/SendGrid) dashboard for inbound email webhooks. The system will automatically look up contacts by email address and use campaign context from recent activities.';
        }
        
        // Optional: Token-based endpoint for per-message webhooks (if needed)
        try {
          const emailToken = await getOrCreateCampaignWebhookToken(
            accountId,
            campaign.id,
            'email',
            req.user?.userId || null
          );
          webhookUrls.email = generateEmailWebhookUrl(emailToken.token, displayBaseUrl);
          webhookUrls.email_note = 'Token-based webhook URL for per-message routing (advanced use case). This includes a unique token for direct campaign context. Note: Email provider dashboard webhook URL is static, so this requires custom integration or testing purposes.';
        } catch (error: any) {
          logger.warn('Failed to create campaign email webhook token', {
            campaignId: campaign.id,
            accountId,
            error: error.message,
          });
          // Don't fail if token creation fails, just skip it
        }
      }
      
      if (campaign.channel === 'sms' || campaign.channel === 'multi') {
        const smsWebhookUrl = env.PUBLIC_WEBHOOK_URL || publicBaseUrl;
        
        // Recommended: Non-token endpoint for Twilio dashboard configuration
        webhookUrls.sms_twilio = `${smsWebhookUrl}/api/webhooks/inbound/sms`;
        if (smsWebhookUrl.includes('localhost') || smsWebhookUrl.includes('127.0.0.1')) {
          webhookUrls.sms_twilio_note = '⚠️ WARNING: This URL uses localhost. Twilio cannot reach localhost URLs. Set PUBLIC_WEBHOOK_URL environment variable to your public domain (e.g., https://yourdomain.com) and configure this URL in your Twilio phone number settings.';
        } else {
          webhookUrls.sms_twilio_note = 'Copy this URL and configure it in your Twilio dashboard under your phone number\'s "Messaging" settings. This is the webhook URL for inbound SMS replies. The system will automatically look up contacts by phone number and use campaign context from recent activities.';
        }
        
        // Optional: Token-based endpoint for per-message webhooks (if needed)
        try {
          const smsToken = await getOrCreateCampaignWebhookToken(
            accountId,
            campaign.id,
            'sms',
            req.user?.userId || null
          );
          webhookUrls.sms = generateSMSWebhookUrl(smsToken.token, smsWebhookUrl);
          if (smsWebhookUrl.includes('localhost') || smsWebhookUrl.includes('127.0.0.1')) {
            webhookUrls.sms_note = '⚠️ WARNING: This URL uses localhost. Token-based webhook for per-message routing (advanced use case). Note: Twilio dashboard webhook URL is static, so this requires custom integration.';
          } else {
            webhookUrls.sms_note = 'Token-based webhook URL for per-message routing (advanced use case). This includes a unique token for direct campaign context. Note: Twilio dashboard webhook URL is static, so this requires custom integration or testing purposes.';
          }
        } catch (error: any) {
          logger.warn('Failed to create campaign SMS webhook token', {
            campaignId: campaign.id,
            accountId,
            error: error.message,
          });
          // Don't fail if token creation fails, just skip it
        }
      }
    } else {
      // Fallback if no account_id
      if (campaign.channel === 'email' || campaign.channel === 'multi') {
          const emailWebhookUrl = env.PUBLIC_WEBHOOK_URL || displayBaseUrl;
          webhookUrls.email_provider = `${emailWebhookUrl}/api/webhooks/inbound/email`;
          if (emailWebhookUrl.includes('localhost') || emailWebhookUrl.includes('127.0.0.1')) {
            webhookUrls.email_provider_note = '⚠️ WARNING: This URL uses localhost. Email providers cannot reach localhost URLs. Set PUBLIC_WEBHOOK_URL environment variable to your public domain (e.g., https://yourdomain.com). Campaign must be associated with a company.';
          } else {
            webhookUrls.email_provider_note = 'Copy this URL and configure it in your email provider (Resend/SendGrid) dashboard for inbound email webhooks. Campaign must be associated with a company.';
          }
        }
        if (campaign.channel === 'sms' || campaign.channel === 'multi') {
          const smsWebhookUrl = env.PUBLIC_WEBHOOK_URL || publicBaseUrl;
          webhookUrls.sms_twilio = `${smsWebhookUrl}/api/webhooks/inbound/sms`;
          if (smsWebhookUrl.includes('localhost') || smsWebhookUrl.includes('127.0.0.1')) {
            webhookUrls.sms_twilio_note = '⚠️ WARNING: This URL uses localhost. Twilio cannot reach localhost URLs. Set PUBLIC_WEBHOOK_URL environment variable to your public domain (e.g., https://yourdomain.com). Campaign must be associated with a company.';
          } else {
            webhookUrls.sms_twilio_note = 'Copy this URL and configure it in your Twilio dashboard under your phone number\'s "Messaging" settings. This is the webhook URL for inbound SMS replies. Campaign must be associated with a company.';
          }
          // Note: Token-based webhook not available without account_id
        }
    }

    res.json({
      success: true,
      data: {
        ...campaign,
        webhook_urls: webhookUrls,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/campaigns - Create new campaign
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = createCampaignSchema.parse(req.body);
    const userId = req.user?.userId;
    
    const result = await queryOne(
      `INSERT INTO campaigns (name, description, type, channel, status, created_by, start_date, end_date, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        validatedData.name,
        validatedData.description || null,
        validatedData.type,
        validatedData.channel,
        validatedData.status || 'draft',
        userId || null,
        validatedData.start_date || null,
        validatedData.end_date || null,
        JSON.stringify(validatedData.metadata || {}),
      ]
    );

    // Refresh knowledge base asynchronously (don't wait for it)
    if (userId) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [userId]
      );
      if (creator?.account_id) {
        // Fire and forget - refresh KB in background
        refreshCompanyKnowledgeBase(creator.account_id).catch(() => {
          // Error already logged in helper function
        });
      }
    }

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// PUT /api/campaigns/:id - Update campaign
router.put('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    const validatedData = createCampaignSchema.partial().parse(req.body);

    const existing = await queryOne<{
      id: string;
      created_by: string | null;
    }>('SELECT id, created_by FROM campaigns WHERE id = $1', [id]);
    
    if (!existing) {
      throw createError('Campaign not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && existing.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [existing.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Campaign update access denied', { userId: req.user.userId, campaignId: id });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(validatedData).forEach(([key, value]) => {
      if (key === 'metadata') {
        updates.push(`${key} = $${paramIndex}`);
        values.push(JSON.stringify(value));
      } else {
        updates.push(`${key} = $${paramIndex}`);
        values.push(value);
      }
      paramIndex++;
    });

    if (updates.length === 0) {
      throw createError('No fields to update', 400);
    }

    values.push(id);
    const result = await queryOne(
      `UPDATE campaigns SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    // Refresh knowledge base asynchronously (don't wait for it)
    if (existing.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [existing.created_by]
      );
      if (creator?.account_id) {
        // Fire and forget - refresh KB in background
        refreshCompanyKnowledgeBase(creator.account_id).catch(() => {
          // Error already logged in helper function
        });
      }
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/campaigns/:id - Delete campaign
router.delete('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    const existing = await queryOne<{
      id: string;
      created_by: string | null;
    }>('SELECT id, created_by FROM campaigns WHERE id = $1', [id]);
    
    if (!existing) {
      throw createError('Campaign not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && existing.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [existing.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Campaign delete access denied', { userId: req.user.userId, campaignId: id });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    await query('DELETE FROM campaigns WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'Campaign deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/campaigns/:id/activate - Activate/reactivate campaign
router.post('/:id/activate', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    const campaign = await queryOne<{
      id: string;
      status: string;
      created_by: string | null;
    }>('SELECT id, status, created_by FROM campaigns WHERE id = $1', [id]);

    if (!campaign) {
      throw createError('Campaign not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && campaign.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [campaign.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Campaign activate access denied', { userId: req.user.userId, campaignId: id });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    const newStatus = campaign.status === 'paused' ? 'running' : 'running';
    const result = await queryOne(
      'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [newStatus, id]
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/campaigns/:id/pause - Pause campaign
router.post('/:id/pause', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    const campaign = await queryOne<{
      id: string;
      status: string;
      created_by: string | null;
    }>('SELECT id, status, created_by FROM campaigns WHERE id = $1', [id]);

    if (!campaign) {
      throw createError('Campaign not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && campaign.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [campaign.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Campaign pause access denied', { userId: req.user.userId, campaignId: id });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    if (campaign.status !== 'running') {
      throw createError('Only running campaigns can be paused', 400);
    }

    const result = await queryOne(
      'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      ['paused', id]
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/campaigns/:id/execute - Execute campaign (send emails/SMS/make calls)
router.post('/:id/execute', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    const { contact_ids, template_id } = req.body;

    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    // Get campaign
    const campaign = await queryOne<{
      id: string;
      name: string;
      type: string;
      channel: string;
      status: string;
      metadata: string;
      created_by: string | null;
    }>('SELECT * FROM campaigns WHERE id = $1', [id]);

    if (!campaign) {
      throw createError('Campaign not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user!) && campaign.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [campaign.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user!);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Campaign execute access denied', { userId: req.user!.userId, campaignId: id });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    // Get template
    let template: any = null;
    if (template_id) {
      template = await queryOne('SELECT * FROM templates WHERE id = $1', [template_id]);
      if (!template) {
        throw createError('Template not found', 404);
      }
    } else {
      // Try to get template from campaign metadata
      const metadata = typeof campaign.metadata === 'string' 
        ? JSON.parse(campaign.metadata) 
        : campaign.metadata;
      if (metadata?.template_id) {
        template = await queryOne('SELECT * FROM templates WHERE id = $1', [metadata.template_id]);
      }
    }

    // For survey campaigns, template is optional (survey link is sent instead)
    if (!template && campaign.type !== 'survey') {
      throw createError('Template is required for campaign execution', 400);
    }

    // For survey campaigns, get survey from metadata
    let survey: any = null;
    if (campaign.type === 'survey') {
      const metadata = typeof campaign.metadata === 'string' 
        ? JSON.parse(campaign.metadata) 
        : campaign.metadata;
      if (metadata?.survey_id) {
        survey = await queryOne('SELECT * FROM surveys WHERE id = $1 AND is_active = true', [metadata.survey_id]);
        if (!survey) {
          throw createError('Survey not found or not active', 404);
        }
      } else {
        throw createError('Survey ID is required for survey campaigns', 400);
      }
    }

    // Get target contacts with company filtering
    let contacts: any[] = [];
    if (contact_ids && Array.isArray(contact_ids) && contact_ids.length > 0) {
      const placeholders = contact_ids.map((_, index) => `$${index + 1}`).join(',');
      let contactQuery = `SELECT * FROM contacts WHERE id IN (${placeholders})`;
      const contactParams = [...contact_ids];
      
      // Apply company filtering for non-super_admin users
      if (!isSuperAdmin(req.user!)) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user!);
        if (userCompanyId) {
          contactQuery += ` AND account_id = $${contactParams.length + 1}`;
          contactParams.push(userCompanyId);
        }
      }
      
      contacts = await query(contactQuery, contactParams);
    } else {
      // Get contacts from campaign metadata or subscription reactivation
      const metadata = typeof campaign.metadata === 'string' 
        ? JSON.parse(campaign.metadata) 
        : campaign.metadata;
      
      if (campaign.type === 'reactivation' && metadata?.days_inactive) {
        // Use subscription reactivation service to get dormant contacts
        const daysInactive = metadata.days_inactive || 90;
        const dormantContacts = await findDormantContacts(daysInactive);
        // Convert to full contact objects
        if (dormantContacts.length > 0) {
          const contactIds = dormantContacts.map(c => c.id);
          const placeholders = contactIds.map((_, index) => `$${index + 1}`).join(',');
          contacts = await query(
            `SELECT * FROM contacts WHERE id IN (${placeholders})`,
            contactIds
          );
        }
      } else if (metadata?.contact_ids) {
        const placeholders = metadata.contact_ids.map((_: string, index: number) => `$${index + 1}`).join(',');
        contacts = await query(
          `SELECT * FROM contacts WHERE id IN (${placeholders})`,
          metadata.contact_ids
        );
      } else {
        throw createError('No contacts specified for campaign execution', 400);
      }
    }

    if (contacts.length === 0) {
      throw createError('No contacts found for campaign execution', 400);
    }

    // Execute campaign based on channel
    const results = {
      total: contacts.length,
      success: 0,
      failed: 0,
      errors: [] as string[],
    };

    const userId = req.user?.userId;
    const metadata = typeof campaign.metadata === 'string' 
      ? JSON.parse(campaign.metadata) 
      : campaign.metadata;

    // Get user's company ID for webhook token creation
    const userCompanyId = req.userCompanyId ?? (req.user ? await getUserCompanyId(req.user) : null);

    // Track contacts that have been successfully contacted (for follow-up tasks)
    const contactedContactIds = new Set<string>();

    for (const contact of contacts) {
      try {
        // Prepare template variables
        const variables: Record<string, string> = {
          first_name: contact.first_name || '',
          last_name: contact.last_name || '',
          email: contact.email || '',
          phone: contact.phone || contact.mobile || '',
          full_name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
        };

        let activityType = 'note';
        let activityDescription = '';
        let activitySubject = '';
        let contactSuccessful = false;
        let emailResult: EmailResult | undefined;
        let smsResult: SMSResult | undefined;
        let callResult: VoiceCallResult | undefined;
        let webhookToken: { id: string; token: string } | null = null;
        let replyToEmail: string | undefined;

        // Generate webhook token for inbound replies (if company ID is available)
        if (userCompanyId && (campaign.channel === 'email' || campaign.channel === 'sms' || campaign.channel === 'multi')) {
          try {
            const tokenType = campaign.channel === 'email' ? 'email' : campaign.channel === 'sms' ? 'sms' : 'both';
            const token = await createWebhookToken({
              account_id: userCompanyId,
              campaign_id: campaign.id,
              contact_id: contact.id,
              type: tokenType,
              created_by: userId || null,
            });
            webhookToken = { id: token.id, token: token.token };
            
            if (tokenType === 'email' || tokenType === 'both') {
              replyToEmail = generateReplyToEmail(token.token);
            }
            // Note: SMS webhooks are now handled via Twilio dashboard configuration
            // We don't need to pass statusCallback for inbound messages
            // Tokens are still created for tracking, but not used in the SMS API call
          } catch (error: any) {
            logger.warn('Failed to create webhook token', { error: error.message, contactId: contact.id });
            // Continue without webhook token - not critical for sending
          }
        }

        // Handle survey campaigns
        if (campaign.type === 'survey' && survey) {
          // Generate survey link (in production, this would be a proper URL)
          const surveyLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/survey/${survey.id}?contact=${contact.id}`;
          
          if (campaign.channel === 'email' || campaign.channel === 'multi') {
            if (!contact.email) {
              results.failed++;
              results.errors.push(`${contact.first_name} ${contact.last_name}: No email address`);
              continue;
            }

            const surveyEmailSubject = `Survey: ${survey.name}`;
            const surveyEmailBody = `Hi ${contact.first_name},\n\nWe'd love to hear your feedback! Please take a moment to complete our survey:\n\n${surveyLink}\n\nThank you!`;

            emailResult = await sendEmailFromTemplate(
              contact.email,
              surveyEmailSubject,
              surveyEmailBody,
              { ...variables, survey_link: surveyLink },
              undefined,
              replyToEmail
            );

            if (emailResult.success) {
              results.success++;
              contactSuccessful = true;
              activityType = 'survey';
              activitySubject = surveyEmailSubject;
              activityDescription = `Sent survey: ${survey.name}`;
            } else {
              results.failed++;
              results.errors.push(`${contact.first_name} ${contact.last_name}: ${emailResult.error}`);
              continue;
            }
          }

          if (campaign.channel === 'sms' || campaign.channel === 'multi') {
            if (!contact.phone && !contact.mobile) {
              results.failed++;
              results.errors.push(`${contact.first_name} ${contact.last_name}: No phone number`);
              continue;
            }

            const surveySMSBody = `Hi ${contact.first_name}, please take our survey: ${surveyLink}`;

            smsResult = await sendSMSFromTemplate(
              contact.phone || contact.mobile,
              surveySMSBody,
              { ...variables, survey_link: surveyLink },
              undefined,
              undefined
            );

            if (smsResult.success) {
              if (campaign.channel !== 'multi') results.success++;
              contactSuccessful = true;
              if (activityType === 'note') {
                activityType = 'survey';
                activityDescription = `Sent survey: ${survey.name}`;
              }
            } else {
              results.failed++;
              results.errors.push(`${contact.first_name} ${contact.last_name}: ${smsResult.error}`);
              if (campaign.channel === 'sms') continue;
            }
          }
        } else if (campaign.channel === 'email' || campaign.channel === 'multi') {
          if (!contact.email) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No email address`);
            continue;
          }

          emailResult = await sendEmailFromTemplate(
            contact.email,
            template.subject || campaign.name,
            template.body,
            variables,
            undefined,
            replyToEmail
          );

          if (emailResult.success) {
            results.success++;
            contactSuccessful = true;
            activityType = 'email';
            activitySubject = template.subject || campaign.name;
            activityDescription = `Sent email: ${template.subject || campaign.name}`;
          } else {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: ${emailResult.error}`);
            continue;
          }
        }

        if (campaign.channel === 'sms' || campaign.channel === 'multi') {
          if (!contact.phone && !contact.mobile) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No phone number`);
            continue;
          }

          // Note: SMS webhooks are configured in Twilio dashboard, not per-message
          smsResult = await sendSMSFromTemplate(
            contact.phone || contact.mobile,
            template.body,
            variables
          );

          if (smsResult.success) {
            if (campaign.channel !== 'multi') results.success++;
            contactSuccessful = true;
            activityType = 'sms';
            activityDescription = `Sent SMS: ${template.name}`;
          } else {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: ${smsResult.error}`);
            if (campaign.channel === 'sms') continue;
          }
        }

        if (campaign.channel === 'call') {
          if (!contact.phone && !contact.mobile) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No phone number`);
            continue;
          }

          callResult = await makeVoiceCallFromTemplate(
            contact.phone || contact.mobile,
            template.body,
            variables
          );

          if (callResult.success) {
            results.success++;
            contactSuccessful = true;
            activityType = 'call';
            activityDescription = `Made call: ${template.name}`;
          } else {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: ${callResult.error}`);
            continue;
          }
        }

        // Create activity record with campaign metadata
        if (activityDescription) {
          const activityMetadata: any = {
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            campaign_type: campaign.type,
            campaign_channel: campaign.channel,
            ...(survey && { survey_id: survey.id, survey_name: survey.name }),
            ...(template && { template_id: template.id, template_name: template.name }),
          };

          // Store message IDs and webhook token for webhook tracking
          if (emailResult?.success && emailResult.messageId) {
            activityMetadata.email_message_id = emailResult.messageId;
            activityMetadata.email_provider = env.EMAIL_PROVIDER || 'sendgrid';
          }
          if (smsResult?.success && smsResult.messageId) {
            activityMetadata.sms_message_sid = smsResult.messageId;
            activityMetadata.sms_provider = 'twilio';
          }
          if (callResult?.success && callResult.callId) {
            activityMetadata.call_sid = callResult.callId;
            activityMetadata.call_provider = 'twilio';
          }
          if (webhookToken) {
            activityMetadata.webhook_token_id = webhookToken.id;
            activityMetadata.webhook_token = webhookToken.token;
            if (replyToEmail) {
              activityMetadata.reply_to_email = replyToEmail;
            }
            // Store webhook token URL for SMS (even though we use dashboard webhook, token is useful for context)
            if (campaign.channel === 'sms' || campaign.channel === 'multi') {
              const publicWebhookUrl = env.PUBLIC_WEBHOOK_URL || env.API_BASE_URL;
              activityMetadata.sms_webhook_url = `${publicWebhookUrl}/api/webhooks/inbound/sms/${webhookToken.token}`;
            }
          }

          const activityResult = await queryOne<{ id: string }>(
            `INSERT INTO activities (type, subject, description, related_to_type, related_to_id, performed_by, metadata, account_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              activityType,
              activitySubject || null,
              activityDescription,
              'contact',
              contact.id,
              userId,
              JSON.stringify(activityMetadata),
              contact.account_id,
            ]
          );

          // Update webhook token with activity ID if created
          if (webhookToken && activityResult) {
            await query(
              'UPDATE webhook_tokens SET activity_id = $1 WHERE id = $2',
              [activityResult.id, webhookToken.id]
            );
          }

          // Update webhook token with activity ID if created
          if (webhookToken && activityResult) {
            await query(
              'UPDATE webhook_tokens SET activity_id = $1 WHERE id = $2',
              [activityResult.id, webhookToken.id]
            );
          }

          // Track successfully contacted contacts for follow-up tasks
          if (contactSuccessful) {
            contactedContactIds.add(contact.id);
          }
        }
      } catch (error: any) {
        results.failed++;
        results.errors.push(`${contact.first_name} ${contact.last_name}: ${error.message}`);
      }
    }

    // Create follow-up tasks for successfully contacted contacts (if enabled)
    if (metadata?.create_followup_task && contactedContactIds.size > 0) {
      const taskTitle = metadata.followup_task_title || `Follow up: ${campaign.name}`;
      const daysUntilDue = metadata.followup_task_days || 3;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + daysUntilDue);

      for (const contactId of contactedContactIds) {
        try {
          const contact = contacts.find(c => c.id === contactId);
          if (!contact) continue;

          const taskDescription = metadata.followup_task_description 
            ? metadata.followup_task_description.replace('{{contact_name}}', `${contact.first_name} ${contact.last_name}`)
            : `Follow up with ${contact.first_name} ${contact.last_name} regarding ${campaign.name}`;

          await query(
            `INSERT INTO tasks (title, description, assigned_to, related_to_type, related_to_id, due_date, status, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              taskTitle,
              taskDescription,
              userId || null, // Assign to campaign creator
              'contact',
              contactId,
              dueDate.toISOString(),
              'pending',
              metadata.followup_task_priority || 'medium',
            ]
          );
          logger.debug('Created follow-up task for campaign', { campaignId: campaign.id, contactId });
        } catch (taskError: any) {
          // Don't fail campaign execution if task creation fails
          logger.warn('Failed to create follow-up task', { error: taskError.message, campaignId: campaign.id, contactId });
        }
      }
    }

    // Update campaign status
    await query(
      'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['completed', id]
    );

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

