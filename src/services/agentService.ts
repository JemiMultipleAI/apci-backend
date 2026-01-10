import { logger } from '../utils/logger';
import { env } from '../config/env';
import { sendMessageToAgent as sendMessageToElevenLabs } from './elevenlabsAgent';
import { sendMessageToOpenAI } from './openaiAgent';

export interface AgentResponse {
  success: boolean;
  response?: string;
  error?: string;
  responseTimeMs?: number;
}

/**
 * Unified agent service that routes to OpenAI or ElevenLabs
 * Automatically falls back to ElevenLabs if OpenAI fails or is not configured
 * 
 * This provides a safe migration path:
 * - Default: Uses ElevenLabs (existing behavior)
 * - With AI_AGENT_PROVIDER=openai: Tries OpenAI first, falls back to ElevenLabs on error (unless disabled)
 * - With DISABLE_ELEVENLABS_FALLBACK=true: OpenAI errors will NOT fallback, forcing OpenAI-only mode
 * - Never breaks existing functionality
 */
export async function sendMessageToAgent(
  agentId: string,
  message: string,
  agentConfigId?: string,
  contactId?: string,
  accountId?: string,
  maxRetries: number = 3
): Promise<AgentResponse> {
  const provider = env.AI_AGENT_PROVIDER || 'elevenlabs';
  const fallbackDisabled = env.DISABLE_ELEVENLABS_FALLBACK === true;
  
  // Log configuration for debugging - ALWAYS log this to see what's happening
  const openAIKey = (env.OPENAI_API_KEY || '').trim();
  const hasOpenAIKey = openAIKey.length > 0;
  const openAIKeyPrefix = hasOpenAIKey ? (openAIKey.substring(0, 15) + '...') : 'NOT SET';
  const openAIKeyLength = openAIKey.length;
  const isProjectKey = openAIKey.startsWith('sk-proj-');
  
  logger.info('[AGENT_SERVICE] 🔍 Provider configuration check', {
    configuredProvider: provider,
    hasOpenAIKey,
    openAIKeyPrefix,
    openAIKeyLength,
    keyType: isProjectKey ? 'project_key (sk-proj-*)' : openAIKey.startsWith('sk-') ? 'standard (sk-*)' : 'unknown_format',
    openAIKeyHasLineBreaks: openAIKey.includes('\n') || openAIKey.includes('\r'),
    openAIModel: env.OPENAI_MODEL,
    willUseOpenAI: provider === 'openai' && hasOpenAIKey,
    fallbackDisabled: fallbackDisabled,
    willFallbackToElevenLabs: (provider !== 'openai' || !hasOpenAIKey) && !fallbackDisabled,
  });

  // If OpenAI is configured as provider, try it first
  if (provider === 'openai' && hasOpenAIKey) {
    logger.info('[AGENT_SERVICE] ✅ Using OpenAI provider', {
      model: env.OPENAI_MODEL,
      agentId: agentId.substring(0, 8) + '...',
      keyType: isProjectKey ? 'project_key' : openAIKey.startsWith('sk-or-') ? 'openrouter' : 'standard',
      apiKeyPrefix: openAIKeyPrefix,
      baseURL: env.OPENAI_BASE_URL || (openAIKey.startsWith('sk-or-') ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'),
    });

    try {
      const response = await sendMessageToOpenAI(
        agentId,
        message,
        agentConfigId,
        contactId,
        accountId,
        maxRetries
      );

      // If OpenAI succeeded, return the response
      if (response.success && response.response) {
        logger.info('[AGENT_SERVICE] OpenAI response successful', {
          responseLength: response.response.length,
          responseTimeMs: response.responseTimeMs,
        });
        return response;
      }

      // If OpenAI failed, check if fallback is disabled
      if (!response.success) {
        if (fallbackDisabled) {
          logger.error('[AGENT_SERVICE] ❌ OpenAI request failed and fallback is DISABLED', {
            error: response.error,
            agentId: agentId.substring(0, 8) + '...',
            willNotFallback: true,
          });
          // Return error instead of falling back
          return {
            success: false,
            error: `OpenAI request failed (fallback disabled): ${response.error}`,
            responseTimeMs: response.responseTimeMs || 0,
          };
        }

        logger.warn('[AGENT_SERVICE] OpenAI request failed, falling back to ElevenLabs', {
          error: response.error,
          agentId: agentId.substring(0, 8) + '...',
        });
        // Fall through to ElevenLabs fallback below
      }
    } catch (error: any) {
      if (fallbackDisabled) {
        logger.error('[AGENT_SERVICE] ❌ OpenAI error and fallback is DISABLED', {
          error: error.message,
          agentId: agentId.substring(0, 8) + '...',
          willNotFallback: true,
        });
        // Return error instead of falling back
        return {
          success: false,
          error: `OpenAI error (fallback disabled): ${error.message}`,
          responseTimeMs: 0,
        };
      }

      // Catch any unexpected errors and fallback
      logger.error('[AGENT_SERVICE] OpenAI error, falling back to ElevenLabs', {
        error: error.message,
        agentId: agentId.substring(0, 8) + '...',
      });
      // Fall through to ElevenLabs fallback below
    }
  }

  // Fallback to ElevenLabs (only if not disabled and provider is not 'openai' or OpenAI key is missing)
  // If provider is 'openai' but fallback is disabled and we got here, OpenAI key must be missing
  if (provider === 'openai' && fallbackDisabled && !hasOpenAIKey) {
    return {
      success: false,
      error: 'OpenAI provider is configured but API key is missing and fallback is disabled',
      responseTimeMs: 0,
    };
  }

  // If fallback is disabled and provider is 'openai' with a key, we should have already returned above
  // This means we're falling back due to OpenAI failure, but fallback is disabled - this shouldn't happen
  if (provider === 'openai' && fallbackDisabled) {
    return {
      success: false,
      error: 'ElevenLabs fallback is disabled. OpenAI must succeed.',
      responseTimeMs: 0,
    };
  }

  const fallbackReason = provider === 'openai' && !hasOpenAIKey
    ? 'OpenAI API key is missing'
    : provider === 'openai' && hasOpenAIKey && !fallbackDisabled
    ? 'OpenAI request failed (see error above)'
    : provider === 'openai' && fallbackDisabled
    ? 'OpenAI failed and fallback is disabled'
    : 'Default provider (AI_AGENT_PROVIDER not set to openai)';
    
  logger.info('[AGENT_SERVICE] 🔄 Using ElevenLabs provider', {
    agentId: agentId.substring(0, 8) + '...',
    reason: fallbackReason,
    configuredProvider: provider,
    openAIKeyStatus: hasOpenAIKey ? 'present' : 'missing',
    fallbackDisabled: fallbackDisabled,
  });

  try {
    const response = await sendMessageToElevenLabs(
      agentId,
      message,
      agentConfigId,
      contactId,
      accountId,
      maxRetries
    );

    return response;
  } catch (error: any) {
    // This should rarely happen as ElevenLabs is the fallback
    logger.error('[AGENT_SERVICE] ElevenLabs fallback also failed', {
      error: error.message,
      agentId: agentId.substring(0, 8) + '...',
    });

    return {
      success: false,
      error: error.message || 'Both OpenAI and ElevenLabs failed',
      responseTimeMs: 0,
    };
  }
}
