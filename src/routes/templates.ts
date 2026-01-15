import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { createError } from '../middleware/errorHandler';

const router = Router();

// DEPRECATED: Templates table has been removed. Campaigns now use AI-generated content via the instructions field.
// This router is kept for backward compatibility but all endpoints return deprecation messages.

router.all('*', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  return res.status(410).json({
    success: false,
    error: 'Templates feature has been deprecated',
    message: 'The templates table has been removed. Campaigns now use AI-generated personalized content via the instructions field. Please update your campaign configuration to use instructions instead of templates.',
    deprecated: true,
  });
});

export default router;
