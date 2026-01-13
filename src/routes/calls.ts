import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { createError, ErrorCodes } from '../middleware/errorHandler';
import { getEffectiveCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';
import { query, queryOne } from '../db/connection';
import { Conversation } from '../models/mongodb/Conversation';

const router = Router();

// GET /api/calls - Get call history
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { 
      contact_id,
      account_id,
      page = '1', 
      limit = '50',
      company_id 
    } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    // Get call activities from PostgreSQL
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const offset = (pageNum - 1) * limitNum;

    let whereClause = "WHERE a.type = 'call'";
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (effectiveCompanyId) {
      whereClause += ` AND a.account_id = $${paramIndex}`;
      params.push(effectiveCompanyId);
      paramIndex++;
    }

    if (contact_id && typeof contact_id === 'string') {
      whereClause += ` AND a.related_to_type = 'contact' AND a.related_to_id = $${paramIndex}`;
      params.push(contact_id);
      paramIndex++;
    }

    if (account_id && typeof account_id === 'string') {
      whereClause += ` AND a.account_id = $${paramIndex}`;
      params.push(account_id);
      paramIndex++;
    }

    const calls = await query<{
      id: string;
      subject: string | null;
      description: string | null;
      related_to_id: string | null;
      performed_by: string | null;
      metadata: string;
      created_at: Date;
      performed_by_name: string | null;
      contact_name: string | null;
      contact_phone: string | null;
    }>(
      `SELECT 
        a.id,
        a.subject,
        a.description,
        a.related_to_id,
        a.performed_by,
        a.metadata,
        a.created_at,
        u.first_name || ' ' || u.last_name as performed_by_name,
        c.first_name || ' ' || c.last_name as contact_name,
        c.mobile as contact_phone
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       LEFT JOIN contacts c ON a.related_to_type = 'contact' AND a.related_to_id = c.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset]
    );

    const totalResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM activities a ${whereClause}`,
      params
    );
    const total = parseInt(totalResult?.count || '0', 10);

    // Enrich with conversation data from MongoDB
    const enrichedCalls = await Promise.all(calls.map(async (call) => {
      const metadata = typeof call.metadata === 'string' 
        ? JSON.parse(call.metadata) 
        : call.metadata || {};

      // Try to find conversation for this call
      let conversation = null;
      if (call.related_to_id && metadata.call_sid) {
        conversation = await Conversation.findOne({
          contact_id: call.related_to_id,
          channel: 'call',
          'messages.metadata.call_sid': metadata.call_sid,
        }).lean();
      }

      return {
        id: call.id,
        callSid: metadata.call_sid || null,
        contactId: call.related_to_id,
        contactName: call.contact_name,
        contactPhone: call.contact_phone,
        performedBy: call.performed_by,
        performedByName: call.performed_by_name,
        subject: call.subject,
        description: call.description,
        duration: metadata.duration || null,
        status: metadata.status || 'unknown',
        recordingUrl: metadata.recording_url || null,
        transcript: conversation 
          ? conversation.messages?.map((m) => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
            }))
          : null,
        createdAt: call.created_at,
        metadata,
      };
    }));

    res.json({
      success: true,
      data: enrichedCalls,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error: any) {
    logger.error('[CALLS] List error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// GET /api/calls/:id - Get single call details
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

    const call = await queryOne<{
      id: string;
      subject: string | null;
      description: string | null;
      related_to_id: string | null;
      performed_by: string | null;
      account_id: string | null;
      metadata: string;
      created_at: Date;
      performed_by_name: string | null;
      contact_name: string | null;
      contact_phone: string | null;
    }>(
      `SELECT 
        a.id,
        a.subject,
        a.description,
        a.related_to_id,
        a.performed_by,
        a.account_id,
        a.metadata,
        a.created_at,
        u.first_name || ' ' || u.last_name as performed_by_name,
        c.first_name || ' ' || c.last_name as contact_name,
        c.mobile as contact_phone
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       LEFT JOIN contacts c ON a.related_to_type = 'contact' AND a.related_to_id = c.id
       WHERE a.id = $1 AND a.type = 'call'`,
      [id]
    );

    if (!call) {
      return next(createError('Call not found', 404, ErrorCodes.NOT_FOUND));
    }

    // Check company access
    if (effectiveCompanyId && call.account_id !== effectiveCompanyId) {
      return next(createError('Forbidden: You do not have access to this call', 403, ErrorCodes.FORBIDDEN));
    }

    const metadata = typeof call.metadata === 'string' 
      ? JSON.parse(call.metadata) 
      : call.metadata || {};

    // Get conversation transcript
    let transcript = null;
    if (call.related_to_id && metadata.call_sid) {
      const conversation = await Conversation.findOne({
        contact_id: call.related_to_id,
        channel: 'call',
        'messages.metadata.call_sid': metadata.call_sid,
      }).lean();

      if (conversation) {
        transcript = conversation.messages?.map((m: any) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          metadata: m.metadata,
        }));
      }
    }

    res.json({
      success: true,
      data: {
        id: call.id,
        callSid: metadata.call_sid || null,
        contactId: call.related_to_id,
        contactName: call.contact_name,
        contactPhone: call.contact_phone,
        performedBy: call.performed_by,
        performedByName: call.performed_by_name,
        subject: call.subject,
        description: call.description,
        duration: metadata.duration || null,
        status: metadata.status || 'unknown',
        recordingUrl: metadata.recording_url || null,
        transcript,
        createdAt: call.created_at,
        metadata,
      },
    });
  } catch (error: any) {
    logger.error('[CALLS] Get error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// GET /api/calls/:id/transcript - Get call transcript only
router.get('/:id/transcript', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { id } = req.params;

    const call = await queryOne<{
      related_to_id: string | null;
      metadata: string;
      account_id: string | null;
    }>(
      'SELECT related_to_id, metadata, account_id FROM activities WHERE id = $1 AND type = $2',
      [id, 'call']
    );

    if (!call) {
      return next(createError('Call not found', 404, ErrorCodes.NOT_FOUND));
    }

    // Check company access
    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      undefined,
      req.userCompanyId
    );

    if (effectiveCompanyId && call.account_id !== effectiveCompanyId) {
      return next(createError('Forbidden: You do not have access to this call', 403, ErrorCodes.FORBIDDEN));
    }

    const metadata = typeof call.metadata === 'string' 
      ? JSON.parse(call.metadata) 
      : call.metadata || {};

    // Get conversation transcript
    let transcript = null;
    if (call.related_to_id && metadata.call_sid) {
      const conversation = await Conversation.findOne({
        contact_id: call.related_to_id,
        channel: 'call',
        'messages.metadata.call_sid': metadata.call_sid,
      }).lean();

      if (conversation) {
        transcript = conversation.messages?.map((m: any) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        }));
      }
    }

    res.json({
      success: true,
      data: { transcript },
    });
  } catch (error: any) {
    logger.error('[CALLS] Transcript error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

export default router;
