import { queryOne } from '../db/connection';
import { sendEmailFromTemplate } from './email';
import { sendSMSFromTemplate } from './sms';
import { sendMessageToAgent } from './elevenlabsAgent';
import { isRateLimited, recordRequest } from './rateLimiter';
import { logAgentEvent } from './agentLogger';
import { logger } from '../utils/logger';
import { validateWebhookToken } from './webhookTokens';
import { Conversation, IConversationMessage } from '../models/mongodb/Conversation';

export interface ProcessInboundMessageOptions {
  token: string;
  messageBody: string;
  senderEmail?: string;
  senderPhone?: string;
  channel: 'email' | 'sms';
  metadata?: Record<string, any>;
}

export interface ProcessInboundMessageByContactOptions {
  contactId: string;
  accountId: string;
  campaignId?: string | null;
  messageBody: string;
  senderEmail?: string;
  senderPhone?: string;
  channel: 'email' | 'sms';
  metadata?: Record<string, any>;
}

export interface ProcessInboundMessageResult {
  success: boolean;
  responseSent: boolean;
  error?: string;
}

/**
 * Process inbound message through ElevenLabs agent and send response
 */
export async function processInboundMessage(
  options: ProcessInboundMessageOptions
): Promise<ProcessInboundMessageResult> {
  const startTime = Date.now();
  
  try {
    logger.info('[INBOUND] Processing inbound message', {
      channel: options.channel,
      token: options.token.substring(0, 8) + '...',
      sender: options.senderEmail || options.senderPhone,
      messageLength: options.messageBody.length,
    });

    // 1. Validate token and get context
    const tokenData = await validateWebhookToken(options.token);
    if (!tokenData) {
      logger.warn('[INBOUND] Invalid webhook token', {
        channel: options.channel,
        token: options.token.substring(0, 8) + '...',
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'invalid_token',
        channel: options.channel,
        errorMessage: 'Invalid or expired webhook token',
        context: { token: options.token },
      });
      return { success: false, responseSent: false, error: 'Invalid token' };
    }

    logger.info('[INBOUND] Token validated', {
      channel: options.channel,
      accountId: tokenData.account_id,
      campaignId: tokenData.campaign_id,
      contactId: tokenData.contact_id,
    });

    const contactId = options.senderEmail || options.senderPhone
      ? await findContactByEmailOrPhone(
          options.senderEmail || options.senderPhone!,
          tokenData.account_id
        )
      : tokenData.contact_id;

    if (!contactId) {
      logger.warn('[INBOUND] Contact not found', {
        sender: options.senderEmail || options.senderPhone,
        accountId: tokenData.account_id,
        tokenContactId: tokenData.contact_id,
        channel: options.channel,
      });
    }

    // 2. Get agent configuration
    logger.debug('[INBOUND] Fetching agent configuration', {
      accountId: tokenData.account_id,
    });

    const agentConfig = await getAgentConfiguration(
      tokenData.account_id
    );

    if (!agentConfig) {
      logger.error('[INBOUND] Agent configuration not found', {
        campaignId: tokenData.campaign_id,
        accountId: tokenData.account_id,
        channel: options.channel,
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'agent_config_not_found',
        contactId: contactId || undefined,
        accountId: tokenData.account_id,
        campaignId: tokenData.campaign_id || undefined,
        channel: options.channel,
        errorMessage: 'No agent configuration found for company',
      });
      return {
        success: false,
        responseSent: false,
        error: 'No agent configuration found',
      };
    }

    logger.info('[INBOUND] Agent configuration found', {
      agentConfigId: agentConfig.id,
      agentName: agentConfig.name,
      agentId: agentConfig.agent_id.substring(0, 8) + '...',
    });

    // 3. Check rate limits
    if (isRateLimited(agentConfig.agent_id)) {
      logger.warn('[INBOUND] Agent rate limit exceeded', {
        agentId: agentConfig.agent_id.substring(0, 8) + '...',
        contactId: contactId,
        channel: options.channel,
      });
      await logAgentEvent({
        level: 'warn',
        eventType: 'rate_limited',
        contactId: contactId || undefined,
        accountId: tokenData.account_id,
        campaignId: tokenData.campaign_id || undefined,
        agentConfigId: agentConfig.id,
        channel: options.channel,
        errorMessage: 'Agent rate limit exceeded',
      });
      // Return success but don't send response (will be queued/retried later)
      return { success: true, responseSent: false };
    }

    // Record request for rate limiting
    recordRequest(agentConfig.agent_id);

    // 4. Send message to ElevenLabs agent
    logger.info('[INBOUND] Sending message to ElevenLabs agent', {
      agentId: agentConfig.agent_id.substring(0, 8) + '...',
      messageLength: options.messageBody.length,
      contactId: contactId,
    });

    const agentRequestStartTime = Date.now();
    const agentResponse = await sendMessageToAgent(
      agentConfig.agent_id,
      options.messageBody,
      agentConfig.id,
      contactId || undefined,
      tokenData.account_id
    );
    const agentResponseTime = Date.now() - agentRequestStartTime;

    if (!agentResponse.success || !agentResponse.response) {
      const errorMessage = agentResponse.error || 'Unknown error from agent';
      logger.error('[INBOUND] Agent request failed', {
        agentId: agentConfig.agent_id.substring(0, 8) + '...',
        error: errorMessage,
        responseTimeMs: agentResponse.responseTimeMs || agentResponseTime,
        contactId: contactId,
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'agent_request_failed',
        contactId: contactId || undefined,
        accountId: tokenData.account_id,
        campaignId: tokenData.campaign_id || undefined,
        agentConfigId: agentConfig.id,
        channel: options.channel,
        errorMessage: agentResponse.error || 'Failed to get agent response',
        context: { requestMessage: options.messageBody },
      });
      return { success: false, responseSent: false, error: agentResponse.error };
    }

    logger.info('[INBOUND] Agent response received', {
      agentId: agentConfig.agent_id.substring(0, 8) + '...',
      responseLength: agentResponse.response.length,
      responseTimeMs: agentResponseTime,
      contactId: contactId,
    });

    // 5. Send response via SMS/Email
    logger.info('[INBOUND] Sending response to user', {
      channel: options.channel,
      recipient: options.senderEmail || options.senderPhone,
      responseLength: agentResponse.response.length,
    });

    let responseSent = false;
    if (options.channel === 'email' && options.senderEmail) {
      const emailResult = await sendEmailFromTemplate(
        options.senderEmail,
        `Re: ${options.metadata?.subject || 'Your message'}`,
        agentResponse.response,
        {},
        undefined,
        undefined // No reply-to needed for outbound responses
      );
      responseSent = emailResult.success;
      
      if (responseSent) {
        logger.info('[INBOUND] Email response sent successfully', {
          recipient: options.senderEmail,
          messageId: emailResult.messageId,
        });
      } else {
        logger.error('[INBOUND] Failed to send email response', {
          recipient: options.senderEmail,
          error: emailResult.error,
        });
      }
    } else if (options.channel === 'sms' && options.senderPhone) {
      const smsResult = await sendSMSFromTemplate(
        options.senderPhone,
        agentResponse.response,
        {},
        undefined,
        undefined // No webhook callback needed for outbound responses
      );
      responseSent = smsResult.success;
      
      if (responseSent) {
        logger.info('[INBOUND] SMS response sent successfully', {
          recipient: options.senderPhone,
          messageId: smsResult.messageId,
        });
      } else {
        logger.error('[INBOUND] Failed to send SMS response', {
          recipient: options.senderPhone,
          error: smsResult.error,
        });
      }
    }

    // 6. Store conversation in MongoDB (for future context)
    if (contactId) {
      await storeConversationMessage(
        contactId,
        tokenData.account_id,
        tokenData.campaign_id || undefined,
        options.channel,
        'user',
        options.messageBody,
        options.metadata?.message_id
      );
      await storeConversationMessage(
        contactId,
        tokenData.account_id,
        tokenData.campaign_id || undefined,
        options.channel,
        'assistant',
        agentResponse.response,
        undefined
      );
    }

    if (!responseSent) {
      logger.error('[INBOUND] Failed to send response to user', {
        channel: options.channel,
        recipient: options.senderEmail || options.senderPhone,
        contactId: contactId,
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'response_send_failed',
        contactId: contactId || undefined,
        accountId: tokenData.account_id,
        campaignId: tokenData.campaign_id || undefined,
        agentConfigId: agentConfig.id,
        channel: options.channel,
        errorMessage: 'Failed to send agent response to user',
        context: { responseMessage: agentResponse.response },
      });
    } else {
      const totalTime = Date.now() - startTime;
      logger.info('[INBOUND] Message processing completed successfully', {
        channel: options.channel,
        contactId: contactId,
        totalTimeMs: totalTime,
        agentResponseTimeMs: agentResponseTime,
        responseSent: true,
      });
    }

    return { success: true, responseSent };
  } catch (error: any) {
    const totalTime = Date.now() - startTime;
    logger.error('[INBOUND] Failed to process inbound message', {
      error: error.message,
      errorStack: error.stack,
      channel: options.channel,
      token: options.token.substring(0, 8) + '...',
      totalTimeMs: totalTime,
    });
    await logAgentEvent({
      level: 'error',
      eventType: 'processing_error',
      channel: options.channel,
      errorMessage: error.message,
      errorStack: error.stack,
      context: { token: options.token },
    });
    return { success: false, responseSent: false, error: error.message };
  }
}

/**
 * Process inbound message by contact (without token) - used for SMS from Twilio dashboard webhook
 */
export async function processInboundMessageByContact(
  options: ProcessInboundMessageByContactOptions
): Promise<ProcessInboundMessageResult> {
  const startTime = Date.now();
  
  try {
    logger.info('[INBOUND] Processing inbound message by contact', {
      channel: options.channel,
      contactId: options.contactId,
      accountId: options.accountId,
      campaignId: options.campaignId,
      sender: options.senderEmail || options.senderPhone,
      messageLength: options.messageBody.length,
    });

    // Get agent configuration
    logger.debug('[INBOUND] Fetching agent configuration', {
      accountId: options.accountId,
    });

    const agentConfig = await getAgentConfiguration(
      options.accountId
    );

    if (!agentConfig) {
      logger.error('[INBOUND] Agent configuration not found', {
        campaignId: options.campaignId,
        accountId: options.accountId,
        channel: options.channel,
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'agent_config_not_found',
        contactId: options.contactId,
        accountId: options.accountId,
        campaignId: options.campaignId || undefined,
        channel: options.channel,
        errorMessage: 'No agent configuration found for company',
      });
      return {
        success: false,
        responseSent: false,
        error: 'No agent configuration found',
      };
    }

    logger.info('[INBOUND] Agent configuration found', {
      agentConfigId: agentConfig.id,
      agentName: agentConfig.name,
      agentId: agentConfig.agent_id.substring(0, 8) + '...',
    });

    // Check rate limits
    if (isRateLimited(agentConfig.agent_id)) {
      logger.warn('[INBOUND] Agent rate limit exceeded', {
        agentId: agentConfig.agent_id.substring(0, 8) + '...',
        contactId: options.contactId,
        channel: options.channel,
      });
      await logAgentEvent({
        level: 'warn',
        eventType: 'rate_limited',
        contactId: options.contactId,
        accountId: options.accountId,
        campaignId: options.campaignId || undefined,
        agentConfigId: agentConfig.id,
        channel: options.channel,
        errorMessage: 'Agent rate limit exceeded',
      });
      return { success: true, responseSent: false };
    }

    // Record request for rate limiting
    recordRequest(agentConfig.agent_id);

    // Send message to ElevenLabs agent
    logger.info('[INBOUND] Sending message to ElevenLabs agent', {
      agentId: agentConfig.agent_id.substring(0, 8) + '...',
      messageLength: options.messageBody.length,
      contactId: options.contactId,
    });

    const agentRequestStartTime = Date.now();
    const agentResponse = await sendMessageToAgent(
      agentConfig.agent_id,
      options.messageBody,
      agentConfig.id,
      options.contactId,
      options.accountId
    );
    const agentResponseTime = Date.now() - agentRequestStartTime;

    if (!agentResponse.success || !agentResponse.response) {
      const errorMessage = agentResponse.error || 'Unknown error from agent';
      logger.error('[INBOUND] Agent request failed', {
        agentId: agentConfig.agent_id.substring(0, 8) + '...',
        error: errorMessage,
        responseTimeMs: agentResponse.responseTimeMs || agentResponseTime,
        contactId: options.contactId,
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'agent_request_failed',
        contactId: options.contactId,
        accountId: options.accountId,
        campaignId: options.campaignId || undefined,
        agentConfigId: agentConfig.id,
        channel: options.channel,
        errorMessage: errorMessage,
        context: { requestMessage: options.messageBody },
      });
      return { success: false, responseSent: false, error: errorMessage };
    }

    logger.info('[INBOUND] Agent response received', {
      agentId: agentConfig.agent_id.substring(0, 8) + '...',
      responseLength: agentResponse.response.length,
      responseTimeMs: agentResponseTime,
      contactId: options.contactId,
    });

    // Send response via SMS/Email
    logger.info('[INBOUND] Sending response to user', {
      channel: options.channel,
      recipient: options.senderEmail || options.senderPhone,
      responseLength: agentResponse.response.length,
    });

    let responseSent = false;
    if (options.channel === 'email' && options.senderEmail) {
      const emailResult = await sendEmailFromTemplate(
        options.senderEmail,
        `Re: ${options.metadata?.subject || 'Your message'}`,
        agentResponse.response,
        {},
        undefined,
        undefined
      );
      responseSent = emailResult.success;
      
      if (responseSent) {
        logger.info('[INBOUND] Email response sent successfully', {
          recipient: options.senderEmail,
          messageId: emailResult.messageId,
        });
      } else {
        logger.error('[INBOUND] Failed to send email response', {
          recipient: options.senderEmail,
          error: emailResult.error,
        });
      }
    } else if (options.channel === 'sms' && options.senderPhone) {
      const smsResult = await sendSMSFromTemplate(
        options.senderPhone,
        agentResponse.response,
        {}
      );
      responseSent = smsResult.success;
      
      if (responseSent) {
        logger.info('[INBOUND] SMS response sent successfully', {
          recipient: options.senderPhone,
          messageId: smsResult.messageId,
        });
      } else {
        logger.error('[INBOUND] Failed to send SMS response', {
          recipient: options.senderPhone,
          error: smsResult.error,
        });
      }
    }

    // Create activity for outbound AI response (if sent)
    if (responseSent && agentResponse.response) {
      const outboundActivityMetadata = {
        original_campaign_id: options.campaignId,
        original_activity_id: options.metadata?.activity_id,
        outbound: true,
        ai_generated: true,
      };
      await queryOne<{ id: string }>(
        `INSERT INTO activities (
          type, subject, description, related_to_type, related_to_id, metadata, account_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [
          options.channel,
          `${options.channel.toUpperCase()} AI Response Sent`,
          agentResponse.response,
          'contact',
          options.contactId,
          JSON.stringify(outboundActivityMetadata),
          options.accountId,
        ]
      );
    }

    // Store conversation history
    await updateConversationHistory(
      options.contactId,
      options.accountId,
      options.campaignId || null,
      options.channel,
      options.messageBody,
      agentResponse.response
    );

    if (!responseSent) {
      logger.error('[INBOUND] Failed to send response to user', {
        channel: options.channel,
        recipient: options.senderEmail || options.senderPhone,
        contactId: options.contactId,
      });
      await logAgentEvent({
        level: 'error',
        eventType: 'response_send_failed',
        contactId: options.contactId,
        accountId: options.accountId,
        campaignId: options.campaignId || undefined,
        agentConfigId: agentConfig.id,
        channel: options.channel,
        errorMessage: 'Failed to send agent response to user',
        context: { responseMessage: agentResponse.response },
      });
    } else {
      const totalTime = Date.now() - startTime;
      logger.info('[INBOUND] Message processing completed successfully', {
        channel: options.channel,
        contactId: options.contactId,
        totalTimeMs: totalTime,
        agentResponseTimeMs: agentResponseTime,
        responseSent: true,
      });
    }

    return { success: true, responseSent };
  } catch (error: any) {
    const totalTime = Date.now() - startTime;
    logger.error('[INBOUND] Failed to process inbound message by contact', {
      error: error.message,
      errorStack: error.stack,
      channel: options.channel,
      contactId: options.contactId,
      totalTimeMs: totalTime,
    });
    await logAgentEvent({
      level: 'error',
      eventType: 'processing_error',
      channel: options.channel,
      contactId: options.contactId,
      accountId: options.accountId,
      errorMessage: error.message,
      errorStack: error.stack,
    });
    return { success: false, responseSent: false, error: error.message };
  }
}

/**
 * Updates or creates a conversation history in MongoDB.
 */
async function updateConversationHistory(
  contactId: string | null,
  accountId: string,
  campaignId: string | null,
  channel: 'email' | 'sms',
  userMessage: string,
  agentResponse: string | undefined
) {
  if (!contactId) {
    logger.warn('Cannot update conversation history: contactId is null');
    return;
  }

  try {
    const userMsg: IConversationMessage = {
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    };

    const updateDoc: any = {
      $push: { messages: userMsg },
      $set: { updated_at: new Date() },
      $setOnInsert: {
        contact_id: contactId,
        account_id: accountId,
        channel: channel,
        created_at: new Date(),
      },
    };

    if (campaignId) {
      updateDoc.$setOnInsert.campaign_id = campaignId;
    }

    if (agentResponse) {
      const agentMsg: IConversationMessage = {
        role: 'assistant',
        content: agentResponse,
        timestamp: new Date(),
      };
      updateDoc.$push.messages.$each = [userMsg, agentMsg];
      delete updateDoc.$push.messages; // Remove single push if using $each
    }

    await Conversation.findOneAndUpdate(
      { contact_id: contactId, channel: channel, account_id: accountId },
      updateDoc,
      { upsert: true, new: true }
    );
    logger.debug('Conversation history updated in MongoDB', { contactId, channel });
  } catch (error: any) {
    logger.error('Failed to update conversation history in MongoDB:', error.message);
  }
}

/**
 * Get agent configuration for company
 */
async function getAgentConfiguration(
  accountId: string
): Promise<{ id: string; agent_id: string; name: string } | null> {
  // Get company agent
  const companyAgent = await queryOne<{
    id: string;
    agent_id: string;
    name: string;
  }>(
    `SELECT id, agent_id, name FROM ai_agent_configurations 
     WHERE account_id = $1 AND is_active = true 
     LIMIT 1`,
    [accountId]
  );

  return companyAgent || null;
}

/**
 * Find contact by email or phone
 */
async function findContactByEmailOrPhone(
  emailOrPhone: string,
  accountId: string
): Promise<string | null> {
  const contact = await queryOne<{ id: string }>(
    `SELECT id FROM contacts 
     WHERE account_id = $1 
     AND (email = $2 OR phone = $2 OR mobile = $2) 
     LIMIT 1`,
    [accountId, emailOrPhone]
  );
  return contact?.id || null;
}

/**
 * Store conversation message in MongoDB
 */
async function storeConversationMessage(
  contactId: string,
  accountId: string,
  campaignId: string | undefined,
  channel: 'email' | 'sms',
  role: 'user' | 'assistant',
  content: string,
  messageId?: string
): Promise<void> {
  if (!isMongoDBAvailable()) {
    return;
  }

  try {
    // Find or create conversation
    let conversation = await Conversation.findOne({
      contact_id: contactId,
      account_id: accountId,
      campaign_id: campaignId || null,
      channel,
    });

    if (!conversation) {
      conversation = await Conversation.create({
        contact_id: contactId,
        account_id: accountId,
        campaign_id: campaignId,
        channel,
        messages: [],
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    // Add message
    conversation.messages.push({
      role,
      content,
      timestamp: new Date(),
      message_id: messageId,
    });

    await conversation.save();
  } catch (error: any) {
    logger.warn('Failed to store conversation message', { error: error.message });
  }
}

/**
 * Check if MongoDB is available
 */
function isMongoDBAvailable(): boolean {
  try {
    const mongoose = require('mongoose');
    return mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
}

