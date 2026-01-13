import { Conversation } from '../models/mongodb/Conversation';
import { logger } from '../utils/logger';

/**
 * Create or update conversation thread
 */
export async function upsertConversation(
  contactId: string,
  accountId: string,
  channel: 'email' | 'sms' | 'call',
  campaignId?: string,
  threadId?: string
) {
  try {
    const filter: any = {
      contact_id: contactId,
      account_id: accountId,
      channel,
    };
    
    if (threadId) {
      filter.thread_id = threadId;
    }
    
    const conversation = await Conversation.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          contact_id: contactId,
          account_id: accountId,
          channel,
          campaign_id: campaignId,
          thread_id: threadId,
          metadata: {
            thread_type: 'outbound',
            message_count: 0,
            agent_responses: 0,
            user_responses: 0,
            first_message_date: new Date(),
            last_message_date: new Date(),
          },
          messages: [],
          created_at: new Date(),
        },
        $set: {
          updated_at: new Date(),
          // REMOVED: 'metadata.last_message_date': new Date(),
          // This causes a conflict because metadata is set in $setOnInsert
          // The last_message_date will be updated by addMessageToConversation anyway
        },
      },
      {
        upsert: true,
        new: true,
      }
    );
    
    return conversation;
  } catch (error: any) {
    logger.error('[CONVERSATION] Failed to upsert conversation', error, {
      contactId,
      accountId,
      channel,
    });
    throw error;
  }
}

/**
 * Add message to conversation
 */
export async function addMessageToConversation(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: {
    message_id?: string;
    sentiment?: number;
    tokens_used?: number;
    transcription_id?: string;
    audio_duration_ms?: number;
    [key: string]: any;
  }
) {
  try {
    const message: any = {
      role,
      content,
      timestamp: new Date(),
      metadata: metadata || {},
    };
    
    if (metadata?.message_id) {
      message.message_id = metadata.message_id;
    }
    
    const update: any = {
      $push: { messages: message },
      $set: {
        updated_at: new Date(),
        'metadata.last_message_date': new Date(),
      },
      $inc: {},
    };
    
    update.$inc['metadata.message_count'] = 1;
    if (role === 'assistant') {
      update.$inc['metadata.agent_responses'] = 1;
    } else {
      update.$inc['metadata.user_responses'] = 1;
    }
    
    await Conversation.findByIdAndUpdate(conversationId, update);
  } catch (error: any) {
    logger.error('[CONVERSATION] Failed to add message', error, {
      conversationId,
      role,
      contentLength: content.length,
    });
    throw error;
  }
}
