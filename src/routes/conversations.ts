import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { createError, ErrorCodes } from '../middleware/errorHandler';
import { getEffectiveCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';
import { Conversation } from '../models/mongodb/Conversation';
import { z } from 'zod';

const router = Router();

// GET /api/conversations - List conversations
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { 
      contact_id, 
      account_id, 
      channel, 
      campaign_id,
      page = '1', 
      limit = '20',
      company_id 
    } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    // Build filter
    const filter: any = {};
    if (effectiveCompanyId) {
      filter.account_id = effectiveCompanyId;
    }
    if (contact_id) {
      filter.contact_id = contact_id as string;
    }
    if (account_id) {
      filter.account_id = account_id as string;
    }
    if (channel) {
      filter.channel = channel as 'email' | 'sms' | 'call';
    }
    if (campaign_id) {
      filter.campaign_id = campaign_id as string;
    }

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    const conversations = await Conversation.find(filter)
      .sort({ updated_at: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const total = await Conversation.countDocuments(filter);

    res.json({
      success: true,
      data: conversations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error: any) {
    logger.error('[CONVERSATIONS] List error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// GET /api/conversations/:id - Get single conversation
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { id } = req.params;
    const { company_id } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    const conversation = await Conversation.findById(id).lean();

    if (!conversation) {
      return next(createError('Conversation not found', 404, ErrorCodes.NOT_FOUND));
    }

    // Check company access
    if (effectiveCompanyId && conversation.account_id !== effectiveCompanyId) {
      return next(createError('Forbidden: You do not have access to this conversation', 403, ErrorCodes.FORBIDDEN));
    }

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error: any) {
    logger.error('[CONVERSATIONS] Get error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// GET /api/conversations/contact/:contactId - Get conversations for a contact
router.get('/contact/:contactId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { contactId } = req.params;
    const { channel, company_id } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    const filter: any = {
      contact_id: contactId,
    };

    if (effectiveCompanyId) {
      filter.account_id = effectiveCompanyId;
    }

    if (channel) {
      filter.channel = channel as 'email' | 'sms' | 'call';
    }

    const conversations = await Conversation.find(filter)
      .sort({ updated_at: -1 })
      .lean();

    res.json({
      success: true,
      data: conversations,
    });
  } catch (error: any) {
    logger.error('[CONVERSATIONS] Contact conversations error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

export default router;
