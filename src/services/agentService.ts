import { logger } from '../utils/logger';
import { env } from '../config/env';
import { sendMessageToOpenAI } from './openaiAgent';

export interface AgentResponse {
  success: boolean;
  response?: string;
  error?: string;
  responseTimeMs?: number;
}

/**
 * Unified agent service using OpenAI Chat API
 * All agent interactions now use OpenAI (ElevenLabs agent removed - TTS only remains)
 */
export async function sendMessageToAgent(
  agentId: string,
  message: string,
  agentConfigId?: string,
  contactId?: string,
  accountId?: string,
  maxRetries: number = 3,
  campaignInstructions?: string // Campaign instructions for AI context
): Promise<AgentResponse> {
  const openAIKey = (env.OPENAI_API_KEY || '').trim();
  const hasOpenAIKey = openAIKey.length > 0;

  if (!hasOpenAIKey) {
    logger.error('[AGENT_SERVICE] OpenAI API key not configured', {
      agentId: agentId.substring(0, 8) + '...',
    });
    return {
      success: false,
      error: 'OpenAI API key is not configured',
      responseTimeMs: 0,
    };
  }

  logger.debug('[AGENT_SERVICE] Sending message to OpenAI', {
    agentId: agentId.substring(0, 8) + '...',
    model: env.OPENAI_MODEL,
    messageLength: message.length,
    hasContactId: !!contactId,
    hasAccountId: !!accountId,
  });

  try {
    const response = await sendMessageToOpenAI(
      agentId,
      message,
      agentConfigId,
      contactId,
      accountId,
      maxRetries,
      campaignInstructions
    );

    if (response.success && response.response) {
      logger.info('[AGENT_SERVICE] Response received', {
        agentId: agentId.substring(0, 8) + '...',
        responseLength: response.response.length,
        responseTimeMs: response.responseTimeMs,
      });
      return response;
    }

    logger.error('[AGENT_SERVICE] OpenAI request failed', {
      agentId: agentId.substring(0, 8) + '...',
      error: response.error,
    });

    return {
      success: false,
      error: response.error || 'OpenAI request failed',
      responseTimeMs: response.responseTimeMs || 0,
    };
  } catch (error: any) {
    logger.error('[AGENT_SERVICE] OpenAI error', {
      agentId: agentId.substring(0, 8) + '...',
      error: error.message,
    });

    return {
      success: false,
      error: error.message || 'OpenAI error occurred',
      responseTimeMs: 0,
    };
  }
}
