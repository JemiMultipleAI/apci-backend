import { Router, Request, Response, NextFunction } from 'express';
import { createError } from '../middleware/errorHandler';
import { z } from 'zod';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { env } from '../config/env';
import { getCampaignsKnowledgeBaseText, getDealsKnowledgeBaseText } from '../utils/knowledgeBaseFormatter';

const router = Router();

// Generate/validate knowledge base token
function generateKnowledgeBaseToken(companyId: string): string {
  const secret = env.KNOWLEDGE_BASE_SECRET || 'default-secret-change-me-in-production';
  return crypto
    .createHmac('sha256', secret)
    .update(companyId)
    .digest('hex');
}

function validateKnowledgeBaseToken(companyId: string, token: string): boolean {
  try {
    const expectedToken = generateKnowledgeBaseToken(companyId);
    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(token, 'hex'),
      Buffer.from(expectedToken, 'hex')
    );
  } catch {
    return false;
  }
}

// GET /api/knowledge-base/:token/company/:companyId/campaigns
router.get('/:token/company/:companyId/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, companyId } = req.params;
    
    // Validate UUID
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(companyId).success) {
      return res.status(400).json({ error: 'Invalid company ID format' });
    }

    // Validate token
    if (!validateKnowledgeBaseToken(companyId, token)) {
      logger.warn('[KNOWLEDGE_BASE] Invalid token attempt', { companyId });
      return res.status(404).json({ error: 'Not found' }); // Return 404 to hide existence
    }

    // Fetch and format campaigns knowledge base text
    const knowledgeBaseText = await getCampaignsKnowledgeBaseText(companyId);

    // Return as plain text (ElevenLabs knowledge base format)
    res.setHeader('Content-Type', 'text/plain');
    res.send(knowledgeBaseText);
    return;
  } catch (error) {
    logger.error('[KNOWLEDGE_BASE] Error fetching campaigns', { error });
    next(error);
    return;
  }
});

// GET /api/knowledge-base/:token/company/:companyId/deals
router.get('/:token/company/:companyId/deals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, companyId } = req.params;
    
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(companyId).success) {
      return res.status(400).json({ error: 'Invalid company ID format' });
    }

    if (!validateKnowledgeBaseToken(companyId, token)) {
      logger.warn('[KNOWLEDGE_BASE] Invalid token attempt', { companyId });
      return res.status(404).json({ error: 'Not found' });
    }

    // Fetch and format deals knowledge base text
    const knowledgeBaseText = await getDealsKnowledgeBaseText(companyId);

    res.setHeader('Content-Type', 'text/plain');
    res.send(knowledgeBaseText);
    return;
  } catch (error) {
    logger.error('[KNOWLEDGE_BASE] Error fetching deals', { error });
    next(error);
    return;
  }
});

export default router;

