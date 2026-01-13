import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { analyzeSentiment, predictChurn, getNextBestAction } from '../services/ai';
import { createError } from '../middleware/errorHandler';
import { env } from '../config/env';

const router = Router();

// GET /api/ai/status - Check AI provider configuration and status
router.get('/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hasOpenAIKey = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0;
    const openAIKeyPrefix = env.OPENAI_API_KEY ? env.OPENAI_API_KEY.substring(0, 7) + '...' : 'not set';
    const openAIKeyLength = env.OPENAI_API_KEY?.length || 0;
    
    const activeProvider = 'openai';
    const reason = hasOpenAIKey ? 'OpenAI is configured and ready' : 'OpenAI API key is missing';
    const isProjectKey = env.OPENAI_API_KEY?.startsWith('sk-proj-');
    const isOpenRouter = env.OPENAI_API_KEY?.startsWith('sk-or-');
    const isCustomBaseURL = !!env.OPENAI_BASE_URL;

    res.json({
      success: true,
      data: {
        provider: activeProvider,
        reason,
        note: 'ElevenLabs agent removed - using OpenAI only (ElevenLabs TTS remains)',
        openai: {
          apiKeyPresent: hasOpenAIKey,
          apiKeyPrefix: openAIKeyPrefix,
          apiKeyLength: openAIKeyLength,
          keyType: isProjectKey ? 'project_key (sk-proj-*)' : isOpenRouter ? 'openrouter (sk-or-*)' : hasOpenAIKey ? 'standard (sk-*)' : 'not_set',
          model: env.OPENAI_MODEL || 'gpt-4o-mini',
          baseURL: env.OPENAI_BASE_URL || (isOpenRouter ? 'https://openrouter.ai/api/v1 (auto-detected)' : 'https://api.openai.com/v1 (default)'),
          isCustomBaseURL: isCustomBaseURL,
          isUsingOpenRouter: isOpenRouter,
          status: hasOpenAIKey ? 'ready' : 'missing_api_key',
        },
        elevenlabs: {
          apiKeyPresent: !!env.ELEVENLABS_API_KEY,
          voiceId: env.ELEVENLABS_VOICE_ID || 'default',
          status: env.ELEVENLABS_API_KEY ? 'ready' : 'missing_api_key',
          note: 'TTS only (agent removed)',
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/sentiment - Analyze sentiment from text
router.post('/sentiment', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      throw createError('Text is required', 400);
    }

    const result = await analyzeSentiment(text);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/ai/churn/:contactId - Predict churn for a contact
router.get('/churn/:contactId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { contactId } = req.params;
    const prediction = await predictChurn(contactId);

    res.json({
      success: true,
      data: {
        contactId,
        ...prediction,
        riskLevel: prediction.probability >= 70 ? 'high' : prediction.probability >= 40 ? 'medium' : 'low',
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/ai/next-action/:contactId - Get next best action for a contact
router.get('/next-action/:contactId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { contactId } = req.params;
    const recommendation = await getNextBestAction(contactId);

    res.json({
      success: true,
      data: {
        contactId,
        ...recommendation,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

