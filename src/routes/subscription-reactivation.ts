import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { findDormantContacts, calculateSubscriptionReactivationScore, getSubscriptionReactivationStats } from '../services/subscriptionReactivation';
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

// GET /api/subscription-reactivation/dormant - Find dormant contacts
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

// GET /api/subscription-reactivation/score/:contactId - Get subscription reactivation score for a contact
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

    const score = await calculateSubscriptionReactivationScore(contactId);

    res.json({
      success: true,
      data: { contactId, score },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/subscription-reactivation/stats/:campaignId - Get subscription reactivation campaign statistics
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

    const stats = await getSubscriptionReactivationStats(campaignId);

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

// POST /api/subscription-reactivation/reactivate - Reactivate one or more contacts
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
    let contactQuery = `SELECT id, first_name, last_name, email, phone, account_id FROM contacts WHERE id IN (${placeholders})`;
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

    // Get or create a default template if not provided
    let templateId = validatedData.template_id;
    if (!templateId) {
      // Try to find a default reactivation template
      const defaultTemplate = await queryOne<{ id: string }>(
        `SELECT id FROM templates 
         WHERE type = 'email' 
         AND (name ILIKE '%reactivation%' OR name ILIKE '%reactivate%')
         ORDER BY created_at DESC 
         LIMIT 1`
      );
      
      if (defaultTemplate) {
        templateId = defaultTemplate.id;
      } else {
        // Get any email template as fallback
        const anyTemplate = await queryOne<{ id: string }>(
          `SELECT id FROM templates 
           WHERE type = 'email' 
           ORDER BY created_at DESC 
           LIMIT 1`
        );
        
        if (!anyTemplate) {
          throw createError('No template found. Please create a template first or provide template_id', 400);
        }
        
        templateId = anyTemplate.id;
        logger.info('Using fallback template for reactivation', { templateId });
      }
    }

    // Verify template exists and user has access
    const template = await queryOne<{ id: string; type: string; account_id: string | null }>(
      'SELECT id, type, account_id FROM templates WHERE id = $1',
      [templateId]
    );

    if (!template) {
      throw createError('Template not found', 404);
    }

    // Check template access for non-super_admin users
    if (!isSuperAdmin(req.user) && template.account_id && template.account_id !== userCompanyId) {
      throw createError('Forbidden: You do not have access to this template', 403);
    }

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
      template_id: templateId,
      days_inactive: validatedData.days_inactive,
      auto_created: true,
      reactivation_type: startDate ? 'scheduled' : 'manual',
    };

    const campaign = await queryOne(
      `INSERT INTO campaigns (name, type, channel, status, created_by, start_date, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        campaignName,
        'reactivation',
        validatedData.channel,
        campaignStatus,
        userId,
        startDate,
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
        templateId,
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
      templateId,
    });

    // Execute the campaign using internal services

    const results = {
      total: contacts.length,
      success: 0,
      failed: 0,
      errors: [] as string[],
      campaign_id: campaign.id,
    };

    // Get full template details
    const fullTemplate = await queryOne('SELECT * FROM templates WHERE id = $1', [templateId]);

    for (const contact of contacts) {
      try {
        // Prepare template variables
        const variables: Record<string, string> = {
          first_name: contact.first_name || '',
          last_name: contact.last_name || '',
          full_name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
        };

        // Replace variables in template
        let subject = fullTemplate.subject || '';
        let body = fullTemplate.body || '';
        
        Object.keys(variables).forEach(key => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          subject = subject.replace(regex, variables[key]);
          body = body.replace(regex, variables[key]);
        });

        // Create webhook token for replies
        let webhookToken: any = null;
        if (userCompanyId && (validatedData.channel === 'email' || validatedData.channel === 'sms' || validatedData.channel === 'multi')) {
          try {
            const tokenType = validatedData.channel === 'email' ? 'email' : validatedData.channel === 'sms' ? 'sms' : 'both';
            webhookToken = await createWebhookToken({
              account_id: userCompanyId,
              campaign_id: campaign.id,
              contact_id: contact.id,
              type: tokenType,
              created_by: userId,
            });
          } catch (error: any) {
            logger.warn('Failed to create webhook token', { error: error.message, contactId: contact.id });
          }
        }

        let success = false;
        let activityType = 'note';
        let activityDescription = '';

        // Send based on channel
        if (validatedData.channel === 'email' || validatedData.channel === 'multi') {
          if (!contact.email) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No email address`);
            continue;
          }

          const replyToEmail = webhookToken ? generateReplyToEmail(webhookToken.token) : undefined;
          const emailResult = await sendEmailFromTemplate(
            contact.email,
            subject,
            body,
            variables,
            undefined,
            replyToEmail
          );

          if (emailResult.success) {
            success = true;
            activityType = 'email';
            activityDescription = `Sent reactivation email: ${subject}`;
          } else {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: ${emailResult.error}`);
            continue;
          }
        }

        if (validatedData.channel === 'sms' || validatedData.channel === 'multi') {
          if (!contact.phone) {
            if (validatedData.channel === 'sms') {
              results.failed++;
              results.errors.push(`${contact.first_name} ${contact.last_name}: No phone number`);
              continue;
            }
          } else {
            const smsResult = await sendSMSFromTemplate(contact.phone, body, variables);
            if (smsResult.success) {
              success = true;
              activityType = validatedData.channel === 'multi' ? 'sms' : 'sms';
              activityDescription = validatedData.channel === 'multi' 
                ? `${activityDescription}; Sent reactivation SMS`
                : `Sent reactivation SMS: ${body.substring(0, 50)}...`;
            } else {
              if (validatedData.channel === 'sms') {
                results.failed++;
                results.errors.push(`${contact.first_name} ${contact.last_name}: ${smsResult.error}`);
                continue;
              }
            }
          }
        }

        if (validatedData.channel === 'call') {
          if (!contact.phone) {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: No phone number`);
            continue;
          }

          const callResult = await makeVoiceCallFromTemplate(contact.phone, body, variables);
          if (callResult.success) {
            success = true;
            activityType = 'call';
            activityDescription = `Made reactivation call`;
          } else {
            results.failed++;
            results.errors.push(`${contact.first_name} ${contact.last_name}: ${callResult.error}`);
            continue;
          }
        }

        if (success) {
          // Create activity record
          const activityMetadata: any = {
            campaign_id: campaign.id,
            reactivation: true,
            channel: validatedData.channel,
          };

          if (webhookToken) {
            activityMetadata.webhook_token_id = webhookToken.id;
            activityMetadata.webhook_token = webhookToken.token;
            if (validatedData.channel === 'email' || validatedData.channel === 'multi') {
              activityMetadata.reply_to_email = webhookToken ? generateReplyToEmail(webhookToken.token) : undefined;
            }
          }

          await queryOne(
            `INSERT INTO activities (type, subject, description, related_to_type, related_to_id, performed_by, metadata, account_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              activityType,
              subject || null,
              activityDescription,
              'contact',
              contact.id,
              userId,
              JSON.stringify(activityMetadata),
              contact.account_id,
            ]
          );

          results.success++;
        }
      } catch (error: any) {
        logger.error('Error reactivating contact', {
          contactId: contact.id,
          error: error.message,
        });
        results.failed++;
        results.errors.push(`${contact.first_name} ${contact.last_name}: ${error.message}`);
      }
    }

    // Update campaign status
    await query(
      'UPDATE campaigns SET status = $1 WHERE id = $2',
      [results.failed === 0 ? 'completed' : 'running', campaign.id]
    );

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

export default router;

