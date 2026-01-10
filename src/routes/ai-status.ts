import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { env } from '../config/env';
import { createError } from '../middleware/errorHandler';

const router = Router();

/**
 * GET /api/ai/status - Get current AI provider configuration
 * Useful for debugging which provider is configured
 */
router.get('/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configuredProvider = env.AI_AGENT_PROVIDER || 'elevenlabs';
    const hasOpenAIKey = !!env.OPENAI_API_KEY;
    const isOpenRouter = env.OPENAI_API_KEY?.startsWith('sk-or-');
    const openAIModel = env.OPENAI_MODEL || 'gpt-4o-mini';
    const baseURL = env.OPENAI_BASE_URL || (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');

    // Determine actual provider that will be used
    let actualProvider: string;
    let actualProviderReason: string;
    
    if (configuredProvider === 'openai' && hasOpenAIKey) {
      actualProvider = 'openai';
      actualProviderReason = 'Configured and API key present';
    } else if (configuredProvider === 'openai' && !hasOpenAIKey) {
      actualProvider = 'elevenlabs';
      actualProviderReason = 'OpenAI configured but no API key - will fallback to ElevenLabs';
    } else {
      actualProvider = 'elevenlabs';
      actualProviderReason = 'Default provider or OpenAI not configured';
    }

    res.json({
      success: true,
      data: {
        configuredProvider,
        actualProvider,
        actualProviderReason,
        openai: {
          configured: configuredProvider === 'openai',
          hasApiKey: hasOpenAIKey,
          apiKeyPrefix: env.OPENAI_API_KEY?.substring(0, 10) + '...' || 'none',
          isOpenRouter,
          model: openAIModel,
          baseURL,
        },
        elevenlabs: {
          hasApiKey: !!env.ELEVENLABS_API_KEY,
          willBeUsed: actualProvider === 'elevenlabs',
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
