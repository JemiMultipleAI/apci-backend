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
    const hasOpenAIKey = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0;
    const isOpenRouter = env.OPENAI_API_KEY?.startsWith('sk-or-');
    const openAIModel = env.OPENAI_MODEL || 'gpt-4o-mini';
    const baseURL = env.OPENAI_BASE_URL || (isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');

    res.json({
      success: true,
      data: {
        provider: 'openai',
        note: 'ElevenLabs agent removed - using OpenAI only (ElevenLabs TTS remains)',
        openai: {
          hasApiKey: hasOpenAIKey,
          apiKeyPrefix: env.OPENAI_API_KEY?.substring(0, 10) + '...' || 'none',
          isOpenRouter,
          model: openAIModel,
          baseURL,
          status: hasOpenAIKey ? 'ready' : 'not_configured',
        },
        elevenlabs: {
          hasApiKey: !!env.ELEVENLABS_API_KEY,
          note: 'TTS only (agent removed)',
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
