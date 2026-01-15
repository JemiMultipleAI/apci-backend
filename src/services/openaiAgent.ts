import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { AgentRequest } from '../models/mongodb/AgentRequest';
import { env } from '../config/env';
import { queryOne } from '../db/connection';
import { getCampaignsKnowledgeBaseText, getDealsKnowledgeBaseText } from '../utils/knowledgeBaseFormatter';
import { Conversation } from '../models/mongodb/Conversation';

export interface AgentResponse {
  success: boolean;
  response?: string;
  error?: string;
  responseTimeMs?: number;
}

/**
 * Send a message to OpenAI and get response
 * Matches the interface of elevenlabsAgent.sendMessageToAgent for easy switching
 */
export async function sendMessageToOpenAI(
  agentId: string, // Not used for OpenAI, but kept for interface compatibility
  message: string,
  agentConfigId?: string,
  contactId?: string,
  accountId?: string,
  maxRetries: number = 3,
  campaignInstructions?: string // Campaign instructions for AI context
): Promise<AgentResponse> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  // Check if OpenAI is configured
  // Trim the key in case there are any whitespace issues
  const apiKey = env.OPENAI_API_KEY?.trim();
  
  if (!apiKey || apiKey.length === 0) {
    const error = 'OPENAI_API_KEY is not configured';
    logger.error('[OPENAI] ' + error);
    return {
      success: false,
      error,
      responseTimeMs: Date.now() - startTime,
    };
  }

  // Validate key format (should start with sk- or sk-proj- for project keys)
  if (!apiKey.startsWith('sk-') && !apiKey.startsWith('sk-proj-')) {
    logger.warn('[OPENAI] API key format may be invalid', {
      keyPrefix: apiKey.substring(0, 10) + '...',
      expectedFormat: 'Should start with sk- or sk-proj-',
    });
  }

  // Initialize OpenAI client
  // Detect if using OpenRouter (key starts with sk-or-) or custom base URL
  const isOpenRouter = apiKey.startsWith('sk-or-');
  const isProjectKey = apiKey.startsWith('sk-proj-');
  const baseURL = env.OPENAI_BASE_URL || (isOpenRouter ? 'https://openrouter.ai/api/v1' : undefined);
  
  logger.info('[OPENAI] Initializing OpenAI client', {
    hasApiKey: true,
    apiKeyPrefix: apiKey.substring(0, 15) + '...',
    apiKeyLength: apiKey.length,
    keyType: isProjectKey ? 'project_key' : isOpenRouter ? 'openrouter' : 'standard',
    isOpenRouter,
    baseURL: baseURL || 'https://api.openai.com/v1 (default)',
    model: env.OPENAI_MODEL,
  });

  const openai = new OpenAI({
    apiKey: apiKey, // Use trimmed key
    ...(baseURL && { baseURL }), // Use custom base URL if provided (for OpenRouter, etc.)
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Exponential backoff: 0s, 1s, 2s, 4s
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 2), 4000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      logger.info('[OPENAI] Sending message to OpenAI', {
        attempt: `${attempt}/${maxRetries}`,
        messageLength: message.length,
        model: env.OPENAI_MODEL,
        contactId,
        accountId,
      });

      // Build context for the prompt
      const systemPrompt = await buildSystemPrompt(accountId, contactId, campaignInstructions);
      const conversationHistory = await getConversationHistory(contactId, accountId);

      // Build messages array
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: systemPrompt,
        },
      ];

      // Add conversation history (last 10 messages to keep context manageable)
      if (conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-10);
        for (const msg of recentHistory) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content,
          });
        }
      }

      // Add current user message
      messages.push({
        role: 'user',
        content: message,
      });

      // Call OpenAI API with timeout wrapper
      const completion = await Promise.race([
        openai.chat.completions.create({
          model: env.OPENAI_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 500, // Reasonable limit for email/SMS responses
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OpenAI API timeout after 30 seconds')), 30000)
        ),
      ]) as OpenAI.Chat.Completions.ChatCompletion;

      const response = completion.choices[0]?.message?.content || '';
      const responseTimeMs = Date.now() - startTime;

      if (!response.trim()) {
        throw new Error('Empty response from OpenAI');
      }

      logger.info('[OPENAI] Response received', {
        responseLength: response.length,
        responseTimeMs,
        tokensUsed: completion.usage?.total_tokens,
      });

      // Log successful request to MongoDB
      if (isMongoDBAvailable()) {
        await AgentRequest.create({
          timestamp: new Date(),
          contact_id: contactId,
          account_id: accountId,
          agent_config_id: agentConfigId,
          agent_id: agentId || 'openai',
          request_message: message,
          response_message: response,
          response_time_ms: responseTimeMs,
          success: true,
          rate_limited: false,
        }).catch((err: any) => logger.warn('Failed to log OpenAI request', { error: err.message }));
      }

      return {
        success: true,
        response,
        responseTimeMs,
      };
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown error';
      const isRateLimited = error?.status === 429 || errorMessage.toLowerCase().includes('rate limit');

      logger.warn('[OPENAI] Request failed', {
        attempt: `${attempt}/${maxRetries}`,
        error: errorMessage,
        errorType: error?.constructor?.name || typeof error,
        isRateLimited,
        willRetry: attempt < maxRetries,
      });

      // If it's the last attempt, log the failure
      if (attempt === maxRetries) {
        const responseTimeMs = Date.now() - startTime;

        if (isMongoDBAvailable()) {
          await AgentRequest.create({
            timestamp: new Date(),
            contact_id: contactId,
            account_id: accountId,
            agent_config_id: agentConfigId,
            agent_id: agentId || 'openai',
            request_message: message,
            response_time_ms: responseTimeMs,
            success: false,
            error: errorMessage,
            rate_limited: isRateLimited,
          }).catch((err: any) => logger.warn('Failed to log OpenAI request failure', { error: err.message }));
        }

        // If rate limited, don't retry
        if (isRateLimited) {
          break;
        }
      }
    }
  }

  const finalResponseTimeMs = Date.now() - startTime;
  const finalErrorMessage = lastError?.message || lastError?.toString() || String(lastError) || 'Failed to get response from OpenAI after retries';

  return {
    success: false,
    error: finalErrorMessage,
    responseTimeMs: finalResponseTimeMs,
  };
}

/**
 * Build system prompt with context about campaigns, deals, and company
 */
async function buildSystemPrompt(
  accountId?: string, 
  contactId?: string,
  campaignInstructions?: string // Campaign instructions for context
): Promise<string> {
  let prompt = `You are Alice, a helpful customer service assistant for a CRM platform. Your goal is to provide helpful, professional, and concise responses to customer inquiries.

Guidelines:
- Your name is Alice - always introduce yourself as Alice
- Be friendly and professional
- Keep responses concise (especially for SMS - under 160 characters when possible)
- If you don't know something, admit it rather than guessing
- Focus on being helpful and resolving the customer's issue
- When customers ask for "more information", "tell me more", or similar requests, proactively provide detailed information about the campaign, product, or service being discussed
- Be informative and helpful - don't just ask what they want, provide useful details based on the context
`;

  // Add company/account information if available
  let companyName: string | null = null;
  if (accountId) {
    try {
      const account = await queryOne<{ name: string }>(
        'SELECT name FROM accounts WHERE id = $1',
        [accountId]
      );
      if (account?.name) {
        companyName = account.name;
        prompt += `\n\nCompany Information:\n- Company Name: ${companyName}\n`;
        logger.debug('[OPENAI] Company information loaded', {
          accountId,
          companyName,
        });
      }
    } catch (error: any) {
      logger.warn('[OPENAI] Failed to load company information', {
        error: error.message,
        accountId,
      });
    }
  }

  // Add instructions for proper introductions
  if (companyName) {
    prompt += `\n\nIMPORTANT - When introducing yourself:\n- Your name is Alice\n- Use the actual company name "${companyName}" when introducing yourself\n- Do NOT use placeholder text like "Your Company" or "Your Name"\n- Simply say you're Alice calling from ${companyName} or representing ${companyName}\n- Be natural and conversational - don't use template-like phrases\n`;
  } else {
    prompt += `\n\nIMPORTANT - When introducing yourself:\n- Your name is Alice\n- Do NOT use placeholder text like "Your Company" or "Your Name"\n- Simply introduce yourself as Alice naturally without mentioning a specific company name\n- Be natural and conversational - don't use template-like phrases\n`;
  }

  // Include campaign instructions if provided (for ongoing conversations)
  if (campaignInstructions && campaignInstructions.trim()) {
    prompt += `\n\nCampaign Instructions:\n${campaignInstructions.trim()}\n\nIMPORTANT: When customers ask for more information or details, use these campaign instructions to provide comprehensive, helpful responses. Don't just ask what they want - proactively share relevant information from the campaign instructions.`;
  }

  // Add knowledge base context if accountId is available
  if (accountId) {
    logger.info('[OPENAI] Loading knowledge base context', { accountId });
    try {
      const campaignsText = await getCampaignsKnowledgeBaseText(accountId);
      const dealsText = await getDealsKnowledgeBaseText(accountId);

      logger.info('[OPENAI] Knowledge base loaded', {
        accountId,
        hasCampaigns: campaignsText && campaignsText !== 'No active campaigns found.',
        hasDeals: dealsText && dealsText !== 'No open deals found.',
        campaignsTextLength: campaignsText?.length || 0,
        dealsTextLength: dealsText?.length || 0,
      });

      if (campaignsText && campaignsText !== 'No active campaigns found.') {
        prompt += `\n\nActive Campaigns:\n${campaignsText}\n`;
      } else {
        logger.debug('[OPENAI] No active campaigns found', { accountId });
      }

      if (dealsText && dealsText !== 'No open deals found.') {
        prompt += `\n\nOpen Deals:\n${dealsText}\n`;
      } else {
        logger.debug('[OPENAI] No open deals found', { accountId });
      }
    } catch (error: any) {
      logger.error('[OPENAI] Failed to load knowledge base context', { 
        error: error.message,
        stack: error.stack,
        accountId 
      });
    }
  } else {
    logger.warn('[OPENAI] No accountId provided - skipping knowledge base context', {
      accountId,
      contactId,
    });
  }

  // Add contact context if contactId is available
  if (contactId && accountId) {
    logger.info('[OPENAI] Loading contact context', { contactId, accountId });
    try {
      const contact = await queryOne<{
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        mobile: string | null;
        lifecycle_stage: string | null;
      }>(
        `SELECT first_name, last_name, email, mobile, lifecycle_stage 
         FROM contacts 
         WHERE id = $1 AND account_id = $2`,
        [contactId, accountId]
      );

      if (contact) {
        const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Customer';
        const lifecycle = contact.lifecycle_stage || 'unknown';
        prompt += `\n\nCustomer Context:\n- Name: ${name}\n- Lifecycle Stage: ${lifecycle}\n`;
        logger.info('[OPENAI] Contact context loaded', {
          contactId,
          name,
          lifecycle,
        });
      } else {
        logger.warn('[OPENAI] Contact not found', { contactId, accountId });
      }
    } catch (error: any) {
      logger.error('[OPENAI] Failed to load contact context', { 
        error: error.message,
        stack: error.stack,
        contactId 
      });
    }
  } else {
    logger.warn('[OPENAI] Missing contactId or accountId - skipping contact context', {
      contactId,
      accountId,
    });
  }

  logger.debug('[OPENAI] System prompt built', {
    promptLength: prompt.length,
    hasAccountId: !!accountId,
    hasContactId: !!contactId,
    hasCampaignInstructions: !!campaignInstructions,
  });

  return prompt;
}

/**
 * Get conversation history from MongoDB for context
 */
async function getConversationHistory(
  contactId?: string,
  accountId?: string
): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>> {
  if (!contactId || !accountId || !isMongoDBAvailable()) {
    return [];
  }

  try {
    // Get conversation history from ALL channels (email, SMS, and call)
    const emailConversation = await Conversation.findOne({
      contact_id: contactId,
      account_id: accountId,
      channel: 'email',
    }).sort({ updated_at: -1 });

    const smsConversation = await Conversation.findOne({
      contact_id: contactId,
      account_id: accountId,
      channel: 'sms',
    }).sort({ updated_at: -1 });

    // Include call channel history
    const callConversation = await Conversation.findOne({
      contact_id: contactId,
      account_id: accountId,
      channel: 'call',
    }).sort({ updated_at: -1 });

    // Use the most recently updated conversation, or combine all
    const conversations = [emailConversation, smsConversation, callConversation].filter(Boolean);
    if (conversations.length === 0) {
      return [];
    }

    // Merge messages from all channels, sort by timestamp
    const allMessages = conversations.flatMap(conv => conv?.messages || []);
    allMessages.sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));

    return allMessages.map(msg => ({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
    }));
  } catch (error: any) {
    logger.warn('[OPENAI] Failed to load conversation history', { error: error.message, contactId });
    return [];
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
