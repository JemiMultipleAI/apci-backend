import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';

const router = Router();

const createActivitySchema = z.object({
  type: z.enum(['call', 'email', 'sms', 'meeting', 'note', 'task', 'survey']),
  subject: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  related_to_type: z.enum(['contact', 'account', 'deal']).optional().nullable(),
  related_to_id: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.any()).optional(),
});

// GET /api/activities - List all activities
router.get('/', authenticate, enrichUser, applyCompanyFilter('a'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '20', type, related_to_type, related_to_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // Apply company filter
    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` ${req.companyFilter.clause}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    if (type) {
      whereClause += ` AND a.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (related_to_type && related_to_id) {
      whereClause += ` AND a.related_to_type = $${paramIndex} AND a.related_to_id = $${paramIndex + 1}`;
      params.push(related_to_type, related_to_id);
      paramIndex += 2;
    }

    const activities = await query(
      `SELECT a.*, 
        u.first_name || ' ' || u.last_name as performed_by_name
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       ${whereClause} 
       ORDER BY a.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM activities a ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: activities,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        totalPages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/activities - Create new activity
router.post('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const validatedData = createActivitySchema.parse(req.body);
    const userId = req.user?.userId;
    
    // Get account_id from related entity
    let accountId: string | null = null;
    if (validatedData.related_to_type && validatedData.related_to_id) {
      if (validatedData.related_to_type === 'contact') {
        const contact = await queryOne<{ account_id: string | null }>(
          'SELECT account_id FROM contacts WHERE id = $1',
          [validatedData.related_to_id]
        );
        accountId = contact?.account_id || null;
      } else if (validatedData.related_to_type === 'account') {
        accountId = validatedData.related_to_id; // Account ID is the account_id itself
      } else if (validatedData.related_to_type === 'deal') {
        const deal = await queryOne<{ account_id: string | null }>(
          'SELECT account_id FROM deals WHERE id = $1',
          [validatedData.related_to_id]
        );
        accountId = deal?.account_id || null;
      }

      // Verify company access for non-super_admin users
      if (!isSuperAdmin(req.user) && accountId) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
        if (userCompanyId !== accountId) {
          return next(createError('Forbidden: You do not have access to this company', 403));
        }
      }
    } else {
      // If no related entity, use user's company
      if (!isSuperAdmin(req.user)) {
        accountId = req.userCompanyId ?? await getUserCompanyId(req.user);
      }
    }
    
    const result = await queryOne(
      `INSERT INTO activities (
        type, subject, description, related_to_type, related_to_id,
        performed_by, metadata, account_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        validatedData.type,
        validatedData.subject || null,
        validatedData.description || null,
        validatedData.related_to_type || null,
        validatedData.related_to_id || null,
        userId || null,
        JSON.stringify(validatedData.metadata || {}),
        accountId,
      ]
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// GET /api/activities/timeline/:type/:id - Get activity timeline for a record
router.get('/timeline/:type/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { type, id } = req.params;
    
    if (!['contact', 'account', 'deal'].includes(type)) {
      throw createError('Invalid related_to_type', 400);
    }

    // Verify company access
    let accountId: string | null = null;
    if (type === 'contact') {
      const contact = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM contacts WHERE id = $1',
        [id]
      );
      accountId = contact?.account_id || null;
    } else if (type === 'account') {
      accountId = id;
    } else if (type === 'deal') {
      const deal = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM deals WHERE id = $1',
        [id]
      );
      accountId = deal?.account_id || null;
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && accountId) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId !== accountId) {
        return next(createError('Forbidden: You do not have access to this company', 403));
      }
    }

    const activities = await query(
      `SELECT a.*, 
        u.first_name || ' ' || u.last_name as performed_by_name
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.related_to_type = $1 AND a.related_to_id = $2
       ORDER BY a.created_at DESC`,
      [type, id]
    );

    res.json({
      success: true,
      data: activities,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

