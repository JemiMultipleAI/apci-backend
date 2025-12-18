import Bull from 'bull';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { sendEmailFromTemplate } from './email';
import { sendSMSFromTemplate } from './sms';
import { makeVoiceCallFromTemplate, replaceTemplateVariables } from './voice';
import { query, queryOne } from '../db/connection';
import { createWebhookToken, generateReplyToEmail } from './webhookTokens';

/**
 * Check if campaign should be marked as completed
 * Campaign is completed when: end_date has passed AND all jobs are done
 */
async function checkCampaignCompletion(campaignId: string): Promise<void> {
  try {
    const campaign = await queryOne<{
      id: string;
      status: string;
      end_date: Date | null;
      metadata: string;
    }>('SELECT id, status, end_date, metadata FROM campaigns WHERE id = $1', [campaignId]);

    if (!campaign || campaign.status === 'completed' || campaign.status === 'draft') {
      return;
    }

    const metadata = typeof campaign.metadata === 'string' 
      ? JSON.parse(campaign.metadata) 
      : campaign.metadata;

    // Check if end_date has passed
    const now = new Date();
    const endDate = campaign.end_date ? new Date(campaign.end_date) : null;
    const endDatePassed = endDate ? now >= endDate : false;

    // If no end_date, we can't auto-complete (campaign runs indefinitely)
    if (!endDate) {
      return;
    }

    // If end_date hasn't passed, don't complete yet
    if (!endDatePassed) {
      return;
    }

    // Check job completion status
    const totalJobs = metadata.total_jobs || 0;
    const completedJobs = metadata.completed_jobs || 0;
    const failedJobs = metadata.failed_jobs || 0;
    const processedJobs = completedJobs + failedJobs;

    // If all jobs are processed (completed or failed), mark campaign as completed
    if (totalJobs > 0 && processedJobs >= totalJobs) {
      await query(
        'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['completed', campaignId]
      );
      logger.info('[CAMPAIGN] Campaign marked as completed', {
        campaignId,
        totalJobs,
        completedJobs,
        failedJobs,
      });
    }
  } catch (error: any) {
    logger.error('[CAMPAIGN] Error checking campaign completion', {
      campaignId,
      error: error.message,
    });
  }
}

// Redis connection configuration
// Use connection object for better control (especially for Redis Cloud with username/TLS)
const redisConfig: any = env.REDIS_URL 
  ? env.REDIS_URL // Use URL if provided (for backward compatibility)
  : {
      host: env.REDIS_HOST || 'localhost',
      port: parseInt(env.REDIS_PORT || '6379', 10),
      ...(env.REDIS_USERNAME && { username: env.REDIS_USERNAME }),
      ...(env.REDIS_PASSWORD && { password: env.REDIS_PASSWORD }),
      // Only enable TLS if explicitly requested via REDIS_TLS environment variable
      ...(env.REDIS_TLS === 'true' || env.REDIS_TLS === '1'
        ? { tls: { rejectUnauthorized: false } }
        : {}),
      // Required for Bull queue
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };

// Create campaign queue
export const campaignQueue = new Bull('campaign-messages', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs
  },
});

export interface CampaignJobData {
  campaignId: string;
  contactId: string;
  channel: 'email' | 'sms' | 'call';
  templateId?: string;
  surveyId?: string;
  variables: Record<string, string>;
  userId?: string;
  accountId?: string;
}

// Process campaign message jobs
// Use 'campaign-message' to match the job name when adding jobs
campaignQueue.process('campaign-message', async (job) => {
  const { campaignId, contactId, channel, templateId, surveyId, variables, userId, accountId } = job.data as CampaignJobData;

  try {
    logger.info('[CAMPAIGN_QUEUE] Processing job', {
      jobId: job.id,
      campaignId,
      contactId,
      channel,
    });

    // Get contact
    const contact = await queryOne('SELECT * FROM contacts WHERE id = $1', [contactId]);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found`);
    }

    // Get campaign
    const campaign = await queryOne('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    let webhookToken: { id: string; token: string } | null = null;
    let replyToEmail: string | undefined;

    // Generate webhook token for inbound replies (if account ID is available)
    if (accountId && (channel === 'email' || channel === 'sms')) {
      try {
        const tokenType = channel === 'email' ? 'email' : 'sms';
        const token = await createWebhookToken({
          account_id: accountId,
          campaign_id: campaignId,
          contact_id: contactId,
          type: tokenType,
          created_by: userId || null,
        });
        webhookToken = { id: token.id, token: token.token };
        
        if (tokenType === 'email') {
          replyToEmail = generateReplyToEmail(token.token);
        }
      } catch (error: any) {
        logger.warn('[CAMPAIGN_QUEUE] Failed to create webhook token', { error: error.message });
      }
    }

    let activityType = 'note';
    let activityDescription = '';
    let activitySubject = '';
    let result: any;

    // Handle survey campaigns
    if (surveyId) {
      const survey = await queryOne('SELECT * FROM surveys WHERE id = $1 AND is_active = true', [surveyId]);
      if (!survey) {
        throw new Error(`Survey ${surveyId} not found or not active`);
      }

      const surveyLink = `${env.FRONTEND_URL || 'http://localhost:3000'}/survey/${survey.id}?contact=${contact.id}`;

      if (channel === 'email') {
        if (!contact.email) {
          throw new Error('Contact has no email address');
        }

        const surveyEmailSubject = `Survey: ${survey.name}`;
        const surveyEmailBody = `Hi ${contact.first_name},\n\nWe'd love to hear your feedback! Please take a moment to complete our survey:\n\n${surveyLink}\n\nThank you!`;

        result = await sendEmailFromTemplate(
          contact.email,
          surveyEmailSubject,
          surveyEmailBody,
          { ...variables, survey_link: surveyLink },
          undefined,
          replyToEmail
        );

        if (result.success) {
          activityType = 'survey';
          activitySubject = surveyEmailSubject;
          activityDescription = `Sent survey: ${survey.name}`;
        } else {
          throw new Error(result.error || 'Failed to send email');
        }
      } else if (channel === 'sms') {
        if (!contact.mobile) {
          throw new Error('Contact has no mobile number');
        }

        const surveySMSBody = `Hi ${contact.first_name}, please take our survey: ${surveyLink}`;
        result = await sendSMSFromTemplate(
          contact.mobile,
          surveySMSBody,
          { ...variables, survey_link: surveyLink }
        );

        if (result.success) {
          activityType = 'survey';
          activityDescription = `Sent survey: ${survey.name}`;
        } else {
          throw new Error(result.error || 'Failed to send SMS');
        }
      } else if (channel === 'call') {
        if (!contact.mobile) {
          throw new Error('Contact has no mobile number');
        }

        // Try to get agent config for the account
        let agentId: string | undefined;
        if (accountId) {
          try {
            const agentConfig = await queryOne<{ agent_id: string }>(
              `SELECT agent_id FROM ai_agent_configurations 
               WHERE account_id = $1 AND is_active = true 
               LIMIT 1`,
              [accountId]
            );
            if (agentConfig) {
              agentId = agentConfig.agent_id;
            }
          } catch (error: any) {
            logger.warn('[CAMPAIGN_QUEUE] Failed to get agent config for survey call, using simple TTS', {
              accountId,
              error: error.message,
            });
          }
        }

        const surveyCallScript = `Hi ${contact.first_name}, we'd love to hear your feedback! Please visit ${surveyLink} to complete our survey. Thank you!`;
        
        // Use agent if available, otherwise use simple TTS
        const useAgent = !!agentId;
        
        result = await makeVoiceCallFromTemplate(
          contact.mobile,
          useAgent ? undefined : surveyCallScript, // Script optional for agent calls
          { ...variables, survey_link: surveyLink },
          undefined, // from
          undefined, // voiceId
          agentId,
          contactId,
          accountId,
          useAgent
        );

        if (result.success) {
          activityType = 'survey';
          activityDescription = useAgent
            ? `Made AI agent call for survey: ${survey.name}`
            : `Made call for survey: ${survey.name}`;
        } else {
          throw new Error(result.error || 'Failed to make voice call');
        }
      }
    } else if (templateId) {
      // Get template
      const template = await queryOne('SELECT * FROM templates WHERE id = $1', [templateId]);
      if (!template) {
        throw new Error(`Template ${templateId} not found`);
      }

      if (channel === 'email') {
        if (!contact.email) {
          throw new Error('Contact has no email address');
        }

        result = await sendEmailFromTemplate(
          contact.email,
          template.subject || campaign.name,
          template.body,
          variables,
          undefined,
          replyToEmail
        );

        if (result.success) {
          activityType = 'email';
          activitySubject = template.subject || campaign.name;
          activityDescription = `Sent email: ${template.subject || campaign.name}`;
        } else {
          throw new Error(result.error || 'Failed to send email');
        }
      } else if (channel === 'sms') {
        if (!contact.mobile) {
          throw new Error('Contact has no mobile number');
        }

        result = await sendSMSFromTemplate(
          contact.mobile,
          template.body,
          variables
        );

        if (result.success) {
          activityType = 'sms';
          activityDescription = `Sent SMS: ${template.name}`;
        } else {
          throw new Error(result.error || 'Failed to send SMS');
        }
      } else if (channel === 'call') {
        if (!contact.mobile) {
          throw new Error('Contact has no mobile number');
        }

        // Try to get agent config for the account
        let agentId: string | undefined;
        if (accountId) {
          try {
            const agentConfig = await queryOne<{ agent_id: string }>(
              `SELECT agent_id FROM ai_agent_configurations 
               WHERE account_id = $1 AND is_active = true 
               LIMIT 1`,
              [accountId]
            );
            if (agentConfig) {
              agentId = agentConfig.agent_id;
            }
          } catch (error: any) {
            logger.warn('[CAMPAIGN_QUEUE] Failed to get agent config, using simple TTS call', {
              accountId,
              error: error.message,
            });
          }
        }

        // Use agent if available, otherwise use simple TTS
        const useAgent = !!agentId;
        // For agent calls, play template first as introduction, then agent takes over
        // For non-agent calls, use template as the full script
        const callScript = replaceTemplateVariables(template.body, variables);

        result = await makeVoiceCallFromTemplate(
          contact.mobile,
          callScript, // Always pass script - plays first for agent calls, full script for non-agent calls
          variables,
          undefined, // from
          undefined, // voiceId
          agentId,
          contactId,
          accountId,
          useAgent
        );

        if (result.success) {
          activityType = 'call';
          activityDescription = useAgent 
            ? `Made AI agent call: ${template.name}` 
            : `Made call: ${template.name}`;
        } else {
          throw new Error(result.error || 'Failed to make voice call');
        }
      }
    } else {
      throw new Error('Either templateId or surveyId must be provided');
    }

    // Create activity record
    const metadata: any = {
      campaign_id: campaignId,
      campaign_name: campaign.name,
      ...(campaign.type && { campaign_type: campaign.type }), // Deprecated, kept for backward compatibility
      campaign_channel: channel,
      ...(surveyId && { survey_id: surveyId }),
      ...(templateId && { template_id: templateId }),
    };

    if (result?.success) {
      if (result.messageId) {
        metadata[`${channel}_message_id`] = result.messageId;
        metadata[`${channel}_provider`] = channel === 'email' ? (env.EMAIL_PROVIDER || 'sendgrid') : 'twilio';
      }
      if (result.callId) {
        metadata.call_sid = result.callId;
        metadata.call_provider = 'twilio';
      }
    }

    if (webhookToken) {
      metadata.webhook_token_id = webhookToken.id;
      metadata.webhook_token = webhookToken.token;
      if (replyToEmail) {
        metadata.reply_to_email = replyToEmail;
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
        contactId,
        userId,
        JSON.stringify(metadata),
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

    // Update campaign metadata with job completion
    // Reuse the campaign we already fetched earlier
    const campaignMetadata = typeof campaign.metadata === 'string' 
      ? JSON.parse(campaign.metadata) 
      : campaign.metadata;
    
    campaignMetadata.completed_jobs = (campaignMetadata.completed_jobs || 0) + 1;
    
    await query(
      'UPDATE campaigns SET metadata = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [JSON.stringify(campaignMetadata), campaignId]
    );

    // Check if campaign should be marked as completed
    await checkCampaignCompletion(campaignId);

    logger.info('[CAMPAIGN_QUEUE] Job completed successfully', {
      jobId: job.id,
      campaignId,
      contactId,
      channel,
    });

    return { success: true, activityId: activityResult?.id };
  } catch (error: any) {
    // Update campaign metadata with job failure
    try {
      const campaignForFailure = await queryOne<{ metadata: string }>(
        'SELECT metadata FROM campaigns WHERE id = $1',
        [campaignId]
      );

      if (campaignForFailure) {
        const failureMetadata = typeof campaignForFailure.metadata === 'string' 
          ? JSON.parse(campaignForFailure.metadata) 
          : campaignForFailure.metadata;
        
        failureMetadata.failed_jobs = (failureMetadata.failed_jobs || 0) + 1;
        
        await query(
          'UPDATE campaigns SET metadata = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [JSON.stringify(failureMetadata), campaignId]
        );

        // Check if campaign should be marked as completed
        await checkCampaignCompletion(campaignId);
      }
    } catch (updateError: any) {
      logger.error('[CAMPAIGN_QUEUE] Error updating campaign metadata on failure', {
        campaignId,
        error: updateError.message,
      });
    }

    logger.error('[CAMPAIGN_QUEUE] Job failed', {
      jobId: job.id,
      campaignId,
      contactId,
      channel,
      error: error.message,
    });
    throw error;
  }
});

// Queue event handlers
campaignQueue.on('completed', (job) => {
  logger.info('[CAMPAIGN_QUEUE] Job completed', { jobId: job.id });
});

campaignQueue.on('failed', (job, err) => {
  logger.error('[CAMPAIGN_QUEUE] Job failed', {
    jobId: job?.id,
    error: err.message,
  });
});

// Redis connection event handlers
campaignQueue.on('error', (error) => {
  logger.error('[CAMPAIGN_QUEUE] Redis connection error', {
    error: error.message,
    stack: error.stack,
  });
});

campaignQueue.on('waiting', (jobId) => {
  logger.debug('[CAMPAIGN_QUEUE] Job waiting', { jobId });
});

// Helper function to get connection info for logging
function getRedisConnectionInfo(): Record<string, any> {
  if (typeof redisConfig === 'string') {
    // REDIS_URL format - mask password for security
    const maskedUrl = redisConfig.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
    return { type: 'URL', url: maskedUrl };
  } else {
    return {
      type: 'Connection',
      host: redisConfig.host || 'localhost',
      port: redisConfig.port || 6379,
    };
  }
}

// Export function to initialize Redis connection (called during server startup)
export async function initializeRedisConnection(): Promise<void> {
  try {
    const isReady = await Promise.race([
      campaignQueue.isReady(),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout after 10 seconds')), 10000)
      ),
    ]);

    if (isReady) {
      const connectionInfo = getRedisConnectionInfo();
      logger.info('[CAMPAIGN_QUEUE] Redis connected and queue ready', connectionInfo);
      console.log('✅ Redis connected successfully');
    } else {
      throw new Error('Redis queue is not ready');
    }
  } catch (error: any) {
    const connectionInfo = getRedisConnectionInfo();
    logger.error('[CAMPAIGN_QUEUE] Failed to connect to Redis', {
      ...connectionInfo,
      error: error.message,
      stack: error.stack,
    });
    logger.warn('[CAMPAIGN_QUEUE] Campaign execution will fail without Redis. Please ensure Redis is running.');
    console.error('❌ Redis connection failed:', error.message);
    console.warn('⚠️  Campaign execution will not work without Redis');
    // Don't throw - allow server to start but campaigns won't work
  }
}

// Also keep the async check for backward compatibility (runs in background)
campaignQueue.isReady().then(() => {
  const connectionInfo = getRedisConnectionInfo();
  logger.info('[CAMPAIGN_QUEUE] Redis connection verified (async)', connectionInfo);
}).catch((error) => {
  const connectionInfo = getRedisConnectionInfo();
  logger.error('[CAMPAIGN_QUEUE] Redis connection check failed (async)', {
    ...connectionInfo,
    error: error.message,
  });
});

// Helper function to calculate delay in milliseconds
export function calculateDelay(delay: number, unit: 'minutes' | 'hours' | 'days'): number {
  const multipliers = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };
  return delay * multipliers[unit];
}

