import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { sendEmailFromTemplate, EmailResult } from '../services/email';
import { sendSMSFromTemplate, SMSResult } from '../services/sms';
import { makeVoiceCallFromTemplate, VoiceCallResult } from '../services/voice';
import { findDormantContacts } from '../services/dormantContacts';
import { logger } from '../utils/logger';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { env } from '../config/env';
import { createWebhookToken, generateReplyToEmail, generateSMSWebhookUrl, generateEmailWebhookUrl, getOrCreateCampaignWebhookToken } from '../services/webhookTokens';
import { updateKnowledgeBaseDocument } from '../services/elevenlabsKnowledgeBase';
import { campaignQueue, calculateDelay, CampaignJobData } from '../services/campaignQueue';

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

const channelConfigSchema = z.object({
  enabled: z.boolean(),
  delay: z.number().min(0),
  unit: z.enum(['minutes', 'hours', 'days']),
});

const createCampaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  type: z.enum(['reactivation', 'marketing', 'survey']).optional(), // Deprecated, kept for backward compatibility
  channel: z.enum(['email', 'sms', 'call', 'multi']),
  status: z.enum(['draft', 'scheduled', 'running', 'paused', 'completed']).optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  metadata: z.object({
    contact_group_ids: z.array(z.string().uuid()).optional(), // Primary method: select by groups
    contact_ids: z.array(z.string().uuid()).optional(), // Deprecated: backward compatibility
    template_id: z.string().uuid().optional(),
    survey_id: z.string().uuid().optional(),
    days_inactive: z.number().optional(), // Optional: filter groups by dormancy
    channels: z.object({
      email: channelConfigSchema.optional(),
      sms: channelConfigSchema.optional(),
      call: channelConfigSchema.optional(),
    }).optional(),
    create_followup_task: z.boolean().optional(),
    followup_task_title: z.string().optional(),
    followup_task_description: z.string().optional(),
    followup_task_days: z.number().optional(),
    followup_task_priority: z.string().optional(),
  }).passthrough().optional(), // passthrough allows additional fields for backward compatibility
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
        validatedData.type || null, // Optional for backward compatibility
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

    // Validate status transition
    if (campaign.status === 'completed') {
      throw createError('Cannot activate a completed campaign', 400);
    }

    if (campaign.status === 'running') {
      throw createError('Campaign is already running', 400);
    }

    // Activate campaign (from draft, paused, or scheduled)
    const result = await queryOne(
      'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      ['running', id]
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

    // Validate status transition
    if (campaign.status !== 'running') {
      throw createError('Only running campaigns can be paused', 400);
    }

    // Note: We don't cancel queued jobs when pausing
    // Jobs will still execute, but campaign status shows as paused
    // This allows for flexibility - admin can pause to stop new executions
    // but already queued messages will still send
    
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

    logger.info('[CAMPAIGN] Execute endpoint called', {
      campaignId: id,
      userId: req.user.userId,
      hasContactIds: !!contact_ids,
      hasTemplateId: !!template_id,
    });

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
      end_date: Date | string | null;
    }>('SELECT * FROM campaigns WHERE id = $1', [id]);

    if (!campaign) {
      throw createError('Campaign not found', 404);
    }

    logger.info('[CAMPAIGN] Campaign found for execution', {
      campaignId: campaign.id,
      campaignName: campaign.name,
      channel: campaign.channel,
      status: campaign.status,
    });

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

    // Parse campaign metadata once
    const metadata = typeof campaign.metadata === 'string' 
      ? JSON.parse(campaign.metadata) 
      : campaign.metadata;

    // Get template
    let template: any = null;
    if (template_id) {
      template = await queryOne('SELECT * FROM templates WHERE id = $1', [template_id]);
      if (!template) {
        throw createError('Template not found', 404);
      }
    } else {
      // Try to get template from campaign metadata
      if (metadata?.template_id) {
        template = await queryOne('SELECT * FROM templates WHERE id = $1', [metadata.template_id]);
      }
    }

    // Check if survey is specified in metadata
    
    let survey: any = null;
    if (metadata?.survey_id) {
      survey = await queryOne('SELECT * FROM surveys WHERE id = $1 AND is_active = true', [metadata.survey_id]);
      if (!survey) {
        throw createError('Survey not found or not active', 404);
      }
    }

    // Template is required if no survey is specified
    if (!template && !survey) {
      throw createError('Either template or survey is required for campaign execution', 400);
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
      // Get contacts from campaign metadata
      // Priority 1: Contact groups (primary method)
      if (metadata?.contact_group_ids && metadata.contact_group_ids.length > 0) {
        let groupQuery = `
          SELECT DISTINCT c.* 
          FROM contacts c
          INNER JOIN contact_group_members cgm ON c.id = cgm.contact_id
          WHERE cgm.contact_group_id = ANY($1)
        `;
        const params: any[] = [metadata.contact_group_ids];
        
        // Optional: Filter groups by dormancy if days_inactive is specified
        if (metadata?.days_inactive) {
          groupQuery += `
            AND (
              SELECT MAX(a.created_at)
              FROM activities a
              WHERE a.related_to_type = 'contact' AND a.related_to_id = c.id
            ) IS NULL
            OR EXTRACT(DAY FROM (
              CURRENT_TIMESTAMP - (
                SELECT MAX(a.created_at)
                FROM activities a
                WHERE a.related_to_type = 'contact' AND a.related_to_id = c.id
              )
            )) >= $2
          `;
          params.push(metadata.days_inactive);
        }
        
        contacts = await query(groupQuery, params);
      } 
      // Priority 2: Dormant contacts (if days_inactive specified without groups)
      else if (metadata?.days_inactive) {
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
      }
      // Priority 3: Individual contact IDs (backward compatibility)
      else if (metadata?.contact_ids && metadata.contact_ids.length > 0) {
        const placeholders = metadata.contact_ids.map((_: string, index: number) => `$${index + 1}`).join(',');
        contacts = await query(
          `SELECT * FROM contacts WHERE id IN (${placeholders})`,
          metadata.contact_ids
        );
      } 
      // Legacy: reactivation type (backward compatibility)
      else if (campaign.type === 'reactivation' && metadata?.days_inactive) {
        const daysInactive = metadata.days_inactive || 90;
        const dormantContacts = await findDormantContacts(daysInactive);
        if (dormantContacts.length > 0) {
          const contactIds = dormantContacts.map(c => c.id);
          const placeholders = contactIds.map((_, index) => `$${index + 1}`).join(',');
          contacts = await query(
            `SELECT * FROM contacts WHERE id IN (${placeholders})`,
            contactIds
          );
        }
      } else {
        throw createError('No contacts specified for campaign execution. Please select contact groups or provide contact IDs.', 400);
      }
    }

    if (contacts.length === 0) {
      throw createError('No contacts found for campaign execution', 400);
    }

    logger.info('[CAMPAIGN] Contacts found for execution', {
      campaignId: campaign.id,
      contactCount: contacts.length,
    });

    // Validate campaign can be executed
    if (campaign.status === 'completed') {
      throw createError('Cannot execute a completed campaign', 400);
    }

    // Check if campaign has passed end_date
    if (campaign.end_date) {
      const endDate = new Date(campaign.end_date);
      const now = new Date();
      if (now > endDate) {
        throw createError('Campaign end date has passed. Cannot execute.', 400);
      }
    }

    const userId = req.user?.userId;
    // metadata is already declared at the top of this function

    // Get user's company ID for webhook token creation
    const userCompanyId = req.userCompanyId ?? (req.user ? await getUserCompanyId(req.user) : null);

    // Get channel configuration from metadata or use legacy channel field
    let channels: {
      email?: { enabled: boolean; delay: number; unit: 'minutes' | 'hours' | 'days' };
      sms?: { enabled: boolean; delay: number; unit: 'minutes' | 'hours' | 'days' };
      call?: { enabled: boolean; delay: number; unit: 'minutes' | 'hours' | 'days' };
    } = {};

    if (metadata?.channels) {
      channels = metadata.channels;
    } else {
      // Backward compatibility: infer from channel field
      const channel = campaign.channel;
      if (channel === 'email') {
        channels = { email: { enabled: true, delay: 0, unit: 'minutes' } };
      } else if (channel === 'sms') {
        channels = { sms: { enabled: true, delay: 0, unit: 'minutes' } };
      } else if (channel === 'call') {
        channels = { call: { enabled: true, delay: 0, unit: 'minutes' } };
      } else if (channel === 'multi') {
        channels = {
          email: { enabled: true, delay: 0, unit: 'minutes' },
          sms: { enabled: true, delay: 60, unit: 'minutes' },
        };
      }
    }

    // Validate at least one channel is enabled
    const enabledChannels = Object.entries(channels).filter(([_, config]) => config.enabled);
    if (enabledChannels.length === 0) {
      throw createError('No channels enabled for campaign execution', 400);
    }

    // Queue jobs for each contact and channel
    const results = {
      total: contacts.length,
      queued: 0,
      failed: 0,
      errors: [] as string[],
      jobs: [] as string[],
    };

    const campaignStartTime = new Date();

    // Collect all job promises first (parallel queuing)
    const jobPromises: Promise<any>[] = [];

    // Prepare template variables for all contacts
    for (const contact of contacts) {
      try {
        // Prepare template variables
        const variables: Record<string, string> = {
          first_name: contact.first_name || '',
          last_name: contact.last_name || '',
          email: contact.email || '',
          mobile: contact.mobile || '',
          full_name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
        };

        // Queue jobs for each enabled channel
        for (const [channelName, channelConfig] of enabledChannels) {
          const channel = channelName as 'email' | 'sms' | 'call';
          
          // Validate contact has required info for channel
          if (channel === 'email' && !contact.email) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No email address for ${channel}`);
            continue;
          }
          if ((channel === 'sms' || channel === 'call') && !contact.mobile) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No mobile number for ${channel}`);
            continue;
          }

          // Calculate delay in milliseconds
          const delayMs = calculateDelay(channelConfig.delay, channelConfig.unit);
          const scheduledTime = new Date(campaignStartTime.getTime() + delayMs);

          // Create job data
          const jobData: CampaignJobData = {
            campaignId: campaign.id,
            contactId: contact.id,
            channel,
            variables,
            userId: userId || undefined,
            accountId: userCompanyId || undefined,
          };

          if (template) {
            jobData.templateId = template.id;
          }
          if (survey) {
            jobData.surveyId = survey.id;
          }

          // Add job promise to array (don't await yet - queue in parallel)
          const jobPromise = campaignQueue.add(
            'campaign-message', // Generic name that matches the process handler
            jobData,
            {
              delay: delayMs,
              jobId: `campaign-${campaign.id}-${channel}-${contact.id}-${Date.now()}-${Math.random()}`,
            }
          ).then((job) => {
            results.queued++;
            results.jobs.push(job.id.toString());
            logger.info('[CAMPAIGN] Queued job', {
              jobId: job.id,
              campaignId: campaign.id,
              contactId: contact.id,
              channel,
              scheduledTime: scheduledTime.toISOString(),
            });
            return job;
          }).catch((error: any) => {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: ${error.message}`);
            logger.error('[CAMPAIGN] Failed to queue job', {
              campaignId: campaign.id,
              contactId: contact.id,
              channel,
              error: error.message,
              stack: error.stack,
            });
            return null; // Don't throw, just track the error
          });

          jobPromises.push(jobPromise);
        }
      } catch (error: any) {
        results.failed++;
        results.errors.push(`${contact.first_name} ${contact.last_name}: ${error.message}`);
      }
    }

    // Wait for all jobs to be queued in parallel (this should be fast - just adding to Redis)
    await Promise.allSettled(jobPromises);

    logger.info('[CAMPAIGN] Campaign execution completed - jobs queued', {
      campaignId: campaign.id,
      totalContacts: results.total,
      queuedJobs: results.queued,
      failedJobs: results.failed,
      totalJobs: results.jobs.length,
    });

    // Store job IDs in campaign metadata for tracking
    const updatedMetadata = {
      ...metadata,
      job_ids: results.jobs,
      total_jobs: results.jobs.length,
      completed_jobs: 0,
      failed_jobs: 0,
    };

    await query(
      'UPDATE campaigns SET metadata = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [JSON.stringify(updatedMetadata), 'running', id]
    );

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/campaigns/:id/status - Get campaign status with job statistics
router.get('/:id/status', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
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
      end_date: Date | string | null;
      metadata: string;
      created_by: string | null;
    }>('SELECT id, status, end_date, metadata, created_by FROM campaigns WHERE id = $1', [id]);

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
        logger.warn('Campaign status access denied', { userId: req.user.userId, campaignId: id });
        throw createError('Forbidden: You do not have access to this campaign', 403);
      }
    }

    const metadata = typeof campaign.metadata === 'string' 
      ? JSON.parse(campaign.metadata) 
      : campaign.metadata;

    const totalJobs = metadata.total_jobs || 0;
    const completedJobs = metadata.completed_jobs || 0;
    const failedJobs = metadata.failed_jobs || 0;
    const processedJobs = completedJobs + failedJobs;
    const pendingJobs = totalJobs - processedJobs;

    const endDate = campaign.end_date ? new Date(campaign.end_date) : null;
    const now = new Date();
    const endDatePassed = endDate ? now >= endDate : false;

    // Check if campaign should be completed (trigger check)
    if (campaign.status === 'running' && endDatePassed && totalJobs > 0 && processedJobs >= totalJobs) {
      await query(
        'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['completed', id]
      );
      campaign.status = 'completed';
    }

    res.json({
      success: true,
      data: {
        status: campaign.status,
        end_date: campaign.end_date,
        end_date_passed: endDatePassed,
        jobs: {
          total: totalJobs,
          completed: completedJobs,
          failed: failedJobs,
          pending: pendingJobs,
          progress_percentage: totalJobs > 0 ? Math.round((processedJobs / totalJobs) * 100) : 0,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/campaigns/queue/health - Check Redis queue health
router.get('/queue/health', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Test Redis connection
    const isReady = await campaignQueue.isReady();
    const waiting = await campaignQueue.getWaitingCount();
    const active = await campaignQueue.getActiveCount();
    const delayed = await campaignQueue.getDelayedCount();
    const completed = await campaignQueue.getCompletedCount();
    const failed = await campaignQueue.getFailedCount();

    res.json({
      success: true,
      data: {
        connected: isReady,
        stats: {
          waiting,
          active,
          delayed,
          completed,
          failed,
        },
      },
    });
  } catch (error: any) {
    res.json({
      success: false,
      error: 'Redis not connected',
      message: error.message,
    });
  }
});

export default router;

