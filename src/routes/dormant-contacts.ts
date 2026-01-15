import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { findDormantContacts, calculateDormantContactScore, getDormantContactStats, calculateSubscriptionReactivationScore, getSubscriptionReactivationStats } from '../services/dormantContacts';
import { createError } from '../middleware/errorHandler';
import { z } from 'zod';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { query, queryOne } from '../db/connection';
import { logger } from '../utils/logger';
import { sendEmailFromTemplate } from '../services/email';
import { sendSMSFromTemplate } from '../services/sms';
import { makeVoiceCallFromTemplate } from '../services/voice';
import { createWebhookToken, generateReplyToEmail } from '../services/webhookTokens';

const router = Router();

// GET /api/dormant-contacts/dormant - Find dormant contacts
router.get('/dormant', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const daysInactive = parseInt(req.query.days as string) || 90;
    const limit = parseInt(req.query.limit as string) || 100;

    const dormantContacts = await findDormantContacts(daysInactive);
    
    // Apply company filtering for non-super_admin users
    let filteredContacts = dormantContacts;
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId) {
        filteredContacts = dormantContacts.filter(contact => contact.account_id === userCompanyId);
      } else {
        filteredContacts = [];
      }
    }

    const limited = filteredContacts.slice(0, limit);

    res.json({
      success: true,
      data: limited,
      total: filteredContacts.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dormant-contacts/score/:contactId - Get dormant contact score for a contact
router.get('/score/:contactId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { contactId } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(contactId).success) {
      throw createError('Invalid contact ID format', 400);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const contact = await query<{ account_id: string | null }>(
        'SELECT account_id FROM contacts WHERE id = $1',
        [contactId]
      );
      
      if (contact.length === 0) {
        throw createError('Contact not found', 404);
      }

      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (contact[0].account_id !== userCompanyId) {
        throw createError('Forbidden: You do not have access to this contact', 403);
      }
    }

    const score = await calculateDormantContactScore(contactId);

    res.json({
      success: true,
      data: { contactId, score },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/dormant-contacts/stats/:campaignId - Get dormant contact campaign statistics
router.get('/stats/:campaignId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { campaignId } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(campaignId).success) {
      throw createError('Invalid campaign ID format', 400);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const campaign = await query<{ created_by: string | null }>(
        'SELECT created_by FROM campaigns WHERE id = $1',
        [campaignId]
      );
      
      if (campaign.length === 0) {
        throw createError('Campaign not found', 404);
      }

      if (campaign[0].created_by) {
        const creator = await query<{ account_id: string | null }>(
          'SELECT account_id FROM users WHERE id = $1',
          [campaign[0].created_by]
        );
        
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
        if (creator.length > 0 && creator[0].account_id !== userCompanyId) {
          throw createError('Forbidden: You do not have access to this campaign', 403);
        }
      }
    }

    const stats = await getDormantContactStats(campaignId);

    const reactivationRate = stats.totalContacts > 0
      ? stats.reactivated / stats.totalContacts
      : 0;

    res.json({
      success: true,
      data: {
        ...stats,
        reactivationRate: Math.round(reactivationRate * 100) / 100,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/dormant-contacts/reactivate - Reactivate one or more contacts
const reactivateSchema = z.object({
  contact_ids: z.array(z.string().uuid()).min(1, 'At least one contact ID is required'),
  template_id: z.string().uuid().optional(),
  channel: z.enum(['email', 'sms', 'call', 'multi']).optional().default('email'),
  days_inactive: z.number().int().positive().optional().default(90),
  scheduled_date: z.string().optional(), // ISO date string
  scheduled_time: z.string().optional(), // Time string (HH:mm)
});

router.post('/reactivate', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const validatedData = reactivateSchema.parse(req.body);
    const userId = req.user.userId;
    const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);

    // Verify all contacts exist and user has access
    const placeholders = validatedData.contact_ids.map((_, index) => `$${index + 1}`).join(',');
    let contactQuery = `SELECT id, first_name, last_name, email, mobile, account_id FROM contacts WHERE id IN (${placeholders})`;
    const contactParams = [...validatedData.contact_ids];

    // Apply company filtering for non-super_admin users
    if (!isSuperAdmin(req.user) && userCompanyId) {
      contactQuery += ` AND account_id = $${contactParams.length + 1}`;
      contactParams.push(userCompanyId);
    }

    const contacts = await query(contactQuery, contactParams);

    if (contacts.length === 0) {
      throw createError('No valid contacts found for reactivation', 404);
    }

    if (contacts.length !== validatedData.contact_ids.length) {
      logger.warn('Some contacts were filtered out due to access restrictions', {
        requested: validatedData.contact_ids.length,
        found: contacts.length,
      });
    }

    // Templates are deprecated - use instructions instead
    // Generate default reactivation instructions if not provided
    const instructions = validatedData.instructions || 
      `You are reaching out to dormant contacts who haven't been active in ${validatedData.days_inactive || 90} days. 
Your goal is to:
1. Re-engage them with a friendly, personalized message
2. Understand why they haven't been active
3. Offer value or updates that might interest them
4. Encourage them to reconnect with your company

Be warm, genuine, and avoid being pushy. Focus on rebuilding the relationship.`;

    // Check if this is a scheduled reactivation
    let startDate: Date | null = null;
    let campaignStatus = 'running';
    
    if (validatedData.scheduled_date && validatedData.scheduled_time) {
      const scheduledDateTime = new Date(`${validatedData.scheduled_date}T${validatedData.scheduled_time}`);
      const now = new Date();
      
      if (scheduledDateTime <= now) {
        throw createError('Scheduled time must be in the future', 400);
      }
      
      startDate = scheduledDateTime;
      campaignStatus = 'scheduled';
    }

    // Create reactivation campaign
    const campaignName = startDate
      ? `Scheduled Reactivation: ${contacts.length} contact${contacts.length > 1 ? 's' : ''} - ${startDate.toISOString().split('T')[0]}`
      : `Reactivation: ${contacts.length} contact${contacts.length > 1 ? 's' : ''} - ${new Date().toISOString().split('T')[0]}`;
    
    const campaignMetadata = {
      contact_ids: contacts.map((c: any) => c.id),
      days_inactive: validatedData.days_inactive,
      auto_created: true,
      reactivation_type: startDate ? 'scheduled' : 'manual',
    };

    const campaign = await queryOne(
      `INSERT INTO campaigns (name, channel, status, created_by, start_date, instructions, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        campaignName,
        validatedData.channel,
        campaignStatus,
        userId,
        startDate,
        instructions,
        JSON.stringify(campaignMetadata),
      ]
    );

    // If scheduled, return early without executing
    if (startDate) {
      logger.info('Scheduled reactivation campaign created', {
        campaignId: campaign.id,
        contactCount: contacts.length,
        scheduledDate: startDate.toISOString(),
        channel: validatedData.channel,
      });

      return res.json({
        success: true,
        data: {
          campaign_id: campaign.id,
          scheduled: true,
          scheduled_date: startDate.toISOString(),
          total: contacts.length,
          message: `Campaign scheduled for ${startDate.toLocaleString()}`,
        },
      });
    }

    logger.info('Reactivation campaign created', {
      campaignId: campaign.id,
      contactCount: contacts.length,
      channel: validatedData.channel,
    });

    // Execute the campaign using the campaign queue service
    // The campaign queue will use the instructions field for AI-generated content
    const { addCampaignJobs } = await import('../services/campaignQueue');
    
    // Queue campaign jobs for execution
    await addCampaignJobs(campaign.id, contacts.map((c: any) => c.id), userCompanyId || undefined);

    // Return success response - actual execution happens via queue
    return res.json({
      success: true,
      data: {
        campaign_id: campaign.id,
        total: contacts.length,
        queued: contacts.length,
        message: 'Campaign queued for execution',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

export default router;

