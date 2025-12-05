import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { analyzeSentiment, predictChurn, getNextBestAction } from '../services/ai';
import { createError } from '../middleware/errorHandler';

const router = Router();

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

