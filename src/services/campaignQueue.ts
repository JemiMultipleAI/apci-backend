import Bull from 'bull';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { sendEmailFromTemplate, sendEmailWithAI } from './email';
import { sendSMSFromTemplate, sendSMSWithAI } from './sms';
import { makeVoiceCallFromTemplate } from './voice';
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
  templateId?: string; // Deprecated - kept for backward compatibility
  surveyId?: string;
  variables: Record<string, string>; // Deprecated - AI handles personalization
  userId?: string;
  accountId?: string;
}

// Process campaign message jobs
// Use 'campaign-message' to match the job name when adding jobs
// Bull v4: process(name, concurrency, processor) - concurrency defaults to 1 if not specified
logger.info('[CAMPAIGN_QUEUE] Queue processor registered for "campaign-message" jobs');
campaignQueue.process('campaign-message', 1, async (job) => {
  const { campaignId, contactId, channel, templateId, surveyId, variables, userId, accountId } = job.data as CampaignJobData;
  // Note: templateId is deprecated but kept for backward compatibility with old campaigns

  try {
    logger.info('[CAMPAIGN_QUEUE] Processing job', {
      jobId: job.id,
      campaignId,
      contactId,
      channel,
      timestamp: new Date().toISOString(),
    });

    // Get contact
    const contact = await queryOne<{
      id: string;
      account_id: string | null;
      first_name: string;
      last_name: string;
      email: string | null;
      mobile: string | null;
      [key: string]: any; // Allow other fields from SELECT *
    }>('SELECT * FROM contacts WHERE id = $1', [contactId]);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found`);
    }

    // Get campaign with created_by to get user's account_id
    const campaign = await queryOne<{
      id: string;
      name: string;
      instructions?: string | null;
      custom_introduction?: string | null;
      use_custom_introduction?: boolean;
      created_by?: string | null;
      [key: string]: any;
    }>('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // CRITICAL: Ensure accountId is available - try multiple sources
    // 1. From job data (accountId parameter)
    // 2. From contact.account_id
    // 3. From campaign creator's account_id (if contact doesn't have one)
    let effectiveAccountId = accountId || contact.account_id || null;

    if (!effectiveAccountId && campaign.created_by) {
      try {
        const creator = await queryOne<{ account_id: string | null }>(
          'SELECT account_id FROM users WHERE id = $1',
          [campaign.created_by]
        );
        if (creator?.account_id) {
          effectiveAccountId = creator.account_id;
          logger.info('[CAMPAIGN_QUEUE] Using accountId from campaign creator', {
            accountId: effectiveAccountId,
            campaignId,
            contactId,
            channel,
            note: 'Contact and job data had no accountId, retrieved from campaign creator',
          });
        }
      } catch (error: any) {
        logger.warn('[CAMPAIGN_QUEUE] Failed to get accountId from campaign creator', {
          error: error.message,
          campaignId,
          createdBy: campaign.created_by,
        });
      }
    }

    if (!effectiveAccountId) {
      logger.warn('[CAMPAIGN_QUEUE] No accountId available - agent will not have CRM context', {
        campaignId,
        contactId,
        channel,
        contactHasAccountId: !!contact.account_id,
        campaignCreatedBy: campaign.created_by || 'none',
        note: 'Contact has no account_id, job data has no accountId, and campaign creator lookup failed - agent responses will be generic',
      });
    } else if (!accountId && contact.account_id) {
      logger.info('[CAMPAIGN_QUEUE] Using accountId from contact', {
        accountId: effectiveAccountId,
        contactId,
        channel,
        note: 'accountId was missing from job data, retrieved from contact.account_id',
      });
    }

    let webhookToken: { id: string; token: string } | null = null;
    let replyToEmail: string | undefined;

    // Generate webhook token for inbound replies (if account ID is available)
    if (effectiveAccountId && (channel === 'email' || channel === 'sms')) {
      try {
        const tokenType = channel === 'email' ? 'email' : 'sms';
        const token = await createWebhookToken({
          account_id: effectiveAccountId,
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

        // Check if OpenAI is configured for agent mode (always use OpenAI now)
        const useAgentForOpenAI = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0;

        // Try to get agent config for the account (for ElevenLabs compatibility)
        let agentId: string | undefined;
        if (useAgentForOpenAI) {
          // For OpenAI, use a placeholder agent ID
          agentId = `openai-survey-${survey.id.substring(0, 8)}`;
          logger.info('[CAMPAIGN_QUEUE] Using OpenAI agent mode for survey call', {
            accountId: effectiveAccountId || 'no-account',
            surveyId: survey.id,
          });
        } else if (effectiveAccountId) {
          try {
            const agentConfig = await queryOne<{ agent_id: string }>(
              `SELECT agent_id FROM ai_agent_configurations 
               WHERE account_id = $1 AND is_active = true 
               LIMIT 1`,
              [effectiveAccountId]
            );
            if (agentConfig) {
              agentId = agentConfig.agent_id;
            }
          } catch (error: any) {
            logger.warn('[CAMPAIGN_QUEUE] Failed to get agent config for survey call, using simple TTS', {
              accountId: effectiveAccountId,
              error: error.message,
            });
          }
        }

        const surveyCallScript = `Hi ${contact.first_name}, we'd love to hear your feedback! Please visit ${surveyLink} to complete our survey. Thank you!`;
        
        // Use agent if OpenAI is configured OR if we found an agent config from database
        const useAgent = useAgentForOpenAI || !!agentId;
        
        result = await makeVoiceCallFromTemplate(
          contact.mobile,
          useAgent ? undefined : surveyCallScript, // Script optional for agent calls
          { ...variables, survey_link: surveyLink },
          undefined, // from
          undefined, // voiceId
          agentId,
          contactId,
          effectiveAccountId || undefined, // Pass effectiveAccountId to voice call
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
    } else if (campaign.instructions) {
      // Use AI-generated personalized content
      if (channel === 'email') {
        if (!contact.email) {
          throw new Error('Contact has no email address');
        }

        // Get custom introduction if enabled
        const customIntroduction = campaign.use_custom_introduction && campaign.custom_introduction
          ? campaign.custom_introduction
          : undefined;

        result = await sendEmailWithAI(
          contact.email,
          campaign.name, // Use campaign name as subject
          campaign.instructions,
          contactId,
          effectiveAccountId || undefined,
          campaignId,
          replyToEmail,
          customIntroduction
        );

        if (result.success) {
          activityType = 'email';
          activitySubject = campaign.name;
          activityDescription = `Sent AI-generated email: ${campaign.name}`;
        } else {
          throw new Error(result.error || 'Failed to send AI email');
        }
      } else if (channel === 'sms') {
        if (!contact.mobile) {
          throw new Error('Contact has no mobile number');
        }

        // Get custom introduction if enabled (reuse from email section if already set)
        const customIntroduction = campaign.use_custom_introduction && campaign.custom_introduction
          ? campaign.custom_introduction
          : undefined;

        result = await sendSMSWithAI(
          contact.mobile,
          campaign.instructions,
          contactId,
          effectiveAccountId || undefined,
          campaignId,
          customIntroduction
        );

        if (result.success) {
          activityType = 'sms';
          activityDescription = `Sent AI-generated SMS: ${campaign.name}`;
        } else {
          throw new Error(result.error || 'Failed to send AI SMS');
        }
      } else if (channel === 'call') {
        if (!contact.mobile) {
          throw new Error('Contact has no mobile number');
        }

        logger.info('[CAMPAIGN_QUEUE] Processing call campaign', {
          campaignId: campaign.id,
          contactId: contact.id,
          accountId: effectiveAccountId,
          mobile: contact.mobile,
        });

        // Check if OpenAI is configured for agent mode (always use OpenAI now)
        const useAgentForOpenAI = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0;

        // Try to get agent config for the account (for ElevenLabs compatibility)
        let agentId: string | undefined;
        if (useAgentForOpenAI) {
          // For OpenAI, we don't need a database agent ID - use a placeholder
          // The actual agent logic is handled by agentService which uses OpenAI Chat API
          agentId = `openai-${campaign.id.substring(0, 8)}`; // Placeholder agent ID
          logger.info('[CAMPAIGN_QUEUE] Using OpenAI agent mode', {
            accountId: effectiveAccountId || 'no-account',
            agentId: agentId.substring(0, 15) + '...',
            openAIModel: env.OPENAI_MODEL,
          });
        } else if (effectiveAccountId) {
          // Fallback: Try to get agent config from database (for ElevenLabs compatibility)
          try {
            logger.debug('[CAMPAIGN_QUEUE] Looking up agent config from database', { accountId: effectiveAccountId });
            const agentConfig = await queryOne<{ agent_id: string }>(
              `SELECT agent_id FROM ai_agent_configurations 
               WHERE account_id = $1 AND is_active = true 
               LIMIT 1`,
              [effectiveAccountId]
            );
            if (agentConfig) {
              agentId = agentConfig.agent_id;
              logger.info('[CAMPAIGN_QUEUE] Agent config found in database', {
                accountId: effectiveAccountId,
                agentId: agentId.substring(0, 8) + '...',
              });
            } else {
              logger.info('[CAMPAIGN_QUEUE] No agent config found in database, will use simple TTS', {
                accountId: effectiveAccountId,
              });
            }
          } catch (error: any) {
            logger.warn('[CAMPAIGN_QUEUE] Failed to get agent config from database, using simple TTS call', {
              accountId: effectiveAccountId,
              error: error.message,
            });
          }
        } else if (!useAgentForOpenAI) {
          logger.warn('[CAMPAIGN_QUEUE] OpenAI not configured, cannot use agent', {
            campaignId: campaign.id,
            hasOpenAIKey: !!env.OPENAI_API_KEY,
          });
        }

        // Use agent if OpenAI is configured OR if we found an agent config from database
        const useAgent = useAgentForOpenAI || !!agentId;
        logger.info('[CAMPAIGN_QUEUE] Call configuration', {
          useAgent,
          agentId: agentId ? agentId.substring(0, 8) + '...' : 'none',
          hasInstructions: !!campaign.instructions,
          note: 'Campaign uses instructions field - AI will personalize conversation',
        });

        // IMPORTANT: For campaigns with instructions, always use agent mode
        // Instructions are for AI-generated personalized content, not template scripts
        // Pass undefined for script - agent mode goes straight to AI conversation
        const callScript = undefined;

        try {
          logger.info('[CAMPAIGN_QUEUE] Making voice call', {
            to: contact.mobile,
            useAgent,
            agentId: agentId ? agentId.substring(0, 8) + '...' : undefined,
            hasInstructions: !!campaign.instructions,
            note: useAgent 
              ? '✅ Agent mode - AI will use campaign instructions to personalize conversation'
              : '⚠️ Warning: OpenAI not configured, but campaign has instructions - call may not work as expected',
          });

          // Get custom introduction if enabled
          const customIntroduction = campaign.use_custom_introduction && campaign.custom_introduction
            ? campaign.custom_introduction
            : undefined;

          // OPTIMIZATION: Start preloading context BEFORE initiating call
          // This gives us a head start while Twilio is connecting (reduces latency)
          if (useAgent && effectiveAccountId && contactId) {
            // Dynamically import the correct bridge module based on VOICE_BRIDGE_MODE
            const bridgeModule = env.VOICE_BRIDGE_MODE === 'optimized' 
              ? './voiceCallBridgeOptimized' 
              : './voiceCallBridge';
            
            import(bridgeModule).then(({ preloadContextBeforeCall }) => {
              preloadContextBeforeCall(
                effectiveAccountId,
                contactId,
                campaign.instructions
              ).catch((error: any) => {
                logger.warn('[CAMPAIGN_QUEUE] Failed to start preload before call', {
                  contactId,
                  accountId: effectiveAccountId,
                  error: error.message,
                  note: 'Will fallback to on-demand loading',
                });
              });
            }).catch((error: any) => {
              logger.warn('[CAMPAIGN_QUEUE] Failed to import bridge module for preload', {
                error: error.message,
                bridgeMode: env.VOICE_BRIDGE_MODE,
                note: 'Will fallback to on-demand loading',
              });
            });
          }

          // Now initiate the call (preloading continues in background)
          result = await makeVoiceCallFromTemplate(
            contact.mobile,
            callScript, // Always undefined for instructions-based campaigns
            variables,
            undefined, // from
            undefined, // voiceId
            agentId,
            contactId,
            effectiveAccountId || undefined, // Pass effectiveAccountId to voice call - ensures agent gets CRM context
            useAgent,
            customIntroduction,
            campaign.instructions // Pass campaign instructions for AI context
          );

          logger.info('[CAMPAIGN_QUEUE] Voice call result', {
            success: result.success,
            callId: result.callId,
            error: result.error,
            useAgent,
          });

          if (result.success) {
            activityType = 'call';
            activityDescription = useAgent 
              ? `Made AI agent call: ${campaign.name}` 
              : `Made call: ${campaign.name}`;
          } else {
            throw new Error(result.error || 'Failed to make voice call');
          }
        } catch (error: any) {
          logger.error('[CAMPAIGN_QUEUE] Voice call failed', {
            error: error.message,
            stack: error.stack,
            useAgent,
            agentId: agentId ? agentId.substring(0, 8) + '...' : undefined,
          });
          throw error;
        }
      }
    } else {
      throw new Error('Either instructions or surveyId must be provided');
    }

    // Create activity record
    const metadata: any = {
      campaign_id: campaignId,
      campaign_name: campaign.name,
      ...(campaign.type && { campaign_type: campaign.type }), // Deprecated, kept for backward compatibility
      campaign_channel: channel,
      ...(surveyId && { survey_id: surveyId }),
      ...(templateId && { template_id: templateId }), // Deprecated, kept for backward compatibility
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

campaignQueue.on('ready', () => {
  logger.info('[CAMPAIGN_QUEUE] Queue is ready to process jobs');
});

campaignQueue.on('waiting', (jobId) => {
  logger.info('[CAMPAIGN_QUEUE] Job waiting', { jobId });
});

campaignQueue.on('delayed', (job) => {
  logger.info('[CAMPAIGN_QUEUE] Job delayed', { 
    jobId: job.id,
    delay: job.opts.delay,
    willProcessAt: new Date(Date.now() + (job.opts.delay || 0)).toISOString(),
  });
});

campaignQueue.on('active', (job) => {
  logger.info('[CAMPAIGN_QUEUE] Job became active', { 
    jobId: job.id,
    campaignId: job.data?.campaignId,
    channel: job.data?.channel,
  });
});

campaignQueue.on('stalled', (job) => {
  logger.warn('[CAMPAIGN_QUEUE] Job stalled', { jobId: job?.id });
});

campaignQueue.on('progress', (job, progress) => {
  logger.debug('[CAMPAIGN_QUEUE] Job progress', { jobId: job.id, progress });
});

// Check queue status periodically to diagnose issues
setTimeout(async () => {
  try {
    const isReady = await campaignQueue.isReady();
    const waitingCount = await campaignQueue.getWaitingCount();
    const activeCount = await campaignQueue.getActiveCount();
    const delayedCount = await campaignQueue.getDelayedCount();
    const failedCount = await campaignQueue.getFailedCount();
    
    logger.info('[CAMPAIGN_QUEUE] Queue status check', {
      isReady,
      waitingCount,
      activeCount,
      delayedCount,
      failedCount,
      processorRegistered: true,
      note: 'If waitingCount > 0 but activeCount = 0, processor may not be picking up jobs',
    });
  } catch (error: any) {
    logger.error('[CAMPAIGN_QUEUE] Error checking queue status', {
      error: error.message,
      stack: error.stack,
    });
  }
}, 5000); // Check 5 seconds after startup

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
    logger.warn('[CAMPAIGN_QUEUE] Campaign execution will fail without Redis. Please ensure Redis is running.', {
      error: error.message,
    });
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

