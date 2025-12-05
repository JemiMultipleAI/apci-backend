import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { hasCompanyAccess, isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { logger } from '../utils/logger';

interface DealQueryResult {
  id: string;
  name: string;
  account_id: string | null;
  contact_id: string | null;
  owner_id: string | null;
  stage: string;
  value: number;
  probability: number;
  expected_close_date: Date | null;
  actual_close_date: Date | null;
  currency: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

const router = Router();

const createDealSchema = z.object({
  name: z.string().min(1),
  account_id: z.string().uuid().optional().nullable(),
  contact_id: z.string().uuid().optional().nullable(),
  owner_id: z.string().uuid().optional().nullable(),
  stage: z.enum(['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']).optional(),
  value: z.number().min(0).optional(),
  probability: z.number().min(0).max(100).optional(),
  expected_close_date: z.string().optional().nullable(),
  currency: z.string().length(3).optional(),
  description: z.string().optional().nullable(),
});

// GET /api/deals - List all deals
router.get('/', authenticate, enrichUser, applyCompanyFilter('d'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10', stage, owner_id, account_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Apply company filter if available
    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` ${req.companyFilter.clause}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    if (stage) {
      const stageStr = Array.isArray(stage) ? stage[0] : stage;
      if (typeof stageStr === 'string') {
        whereClause += ` AND stage = $${paramIndex}`;
        params.push(stageStr);
        paramIndex++;
      }
    }

    if (owner_id) {
      const ownerIdStr = Array.isArray(owner_id) ? owner_id[0] : owner_id;
      if (typeof ownerIdStr === 'string') {
        whereClause += ` AND owner_id = $${paramIndex}`;
        params.push(ownerIdStr);
        paramIndex++;
      }
    }

    if (account_id) {
      const accountIdStr = Array.isArray(account_id) ? account_id[0] : account_id;
      if (typeof accountIdStr === 'string') {
        whereClause += ` AND account_id = $${paramIndex}`;
        params.push(accountIdStr);
        paramIndex++;
      }
    }

    const deals = await query<DealQueryResult & { account_name: string | null; contact_name: string | null }>(
      `SELECT d.*, 
        a.name as account_name,
        c.first_name || ' ' || c.last_name as contact_name
       FROM deals d
       LEFT JOIN accounts a ON d.account_id = a.id
       LEFT JOIN contacts c ON d.contact_id = c.id
       ${whereClause} 
       ORDER BY d.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM deals d ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: deals,
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

// GET /api/deals/pipeline - Get pipeline summary
router.get('/pipeline', authenticate, enrichUser, applyCompanyFilter(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    let whereClause = "WHERE stage NOT IN ('closed_won', 'closed_lost')";
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` ${req.companyFilter.clause}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    const pipeline = await query(
      `SELECT 
        stage,
        COUNT(*) as count,
        COALESCE(SUM(value), 0) as total_value,
        COALESCE(AVG(probability), 0) as avg_probability
       FROM deals
       ${whereClause}
       GROUP BY stage
       ORDER BY 
         CASE stage
           WHEN 'lead' THEN 1
           WHEN 'qualified' THEN 2
           WHEN 'proposal' THEN 3
           WHEN 'negotiation' THEN 4
         END`,
      params
    );

    const forecast = await queryOne<{ forecast: string }>(
      `SELECT COALESCE(SUM(value * probability / 100.0), 0) as forecast
       FROM deals
       ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        pipeline,
        forecast: parseFloat(forecast?.forecast || '0'),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/deals/:id - Get single deal
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid deal ID format', 400);
    }
    
    const deal = await queryOne<DealQueryResult & { account_name: string | null; contact_name: string | null }>(
      `SELECT d.*, 
        a.name as account_name,
        c.first_name || ' ' || c.last_name as contact_name
       FROM deals d
       LEFT JOIN accounts a ON d.account_id = a.id
       LEFT JOIN contacts c ON d.contact_id = c.id
       WHERE d.id = $1`,
      [id]
    );

    if (!deal) {
      throw createError('Deal not found', 404);
    }

    // Check company access if deal has an account_id
    if (deal.account_id) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (!isSuperAdmin(req.user) && userCompanyId !== deal.account_id) {
        logger.warn('Deal access denied', { userId: req.user.userId, dealId: id, dealAccountId: deal.account_id, userCompanyId });
        throw createError('Forbidden: You do not have access to this deal', 403);
      }
    }

    res.json({
      success: true,
      data: deal,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/deals - Create new deal
router.post('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = createDealSchema.parse(req.body);
    
    // Validate UUID format for account_id if provided
    if (validatedData.account_id) {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(validatedData.account_id).success) {
        throw createError('Invalid company ID format', 400);
      }
      
      // Check company access if account_id is provided
      if (!isSuperAdmin(req.user!)) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user!);
        if (userCompanyId !== validatedData.account_id) {
          logger.warn('Deal creation denied: Invalid company', { userId: req.user!.userId, requestedCompanyId: validatedData.account_id, userCompanyId });
          throw createError('Forbidden: You can only create deals for your own company', 403);
        }
      }
    }
    
    const result = await queryOne<DealQueryResult>(
      `INSERT INTO deals (
        name, account_id, contact_id, owner_id, stage, value, 
        probability, expected_close_date, currency, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        validatedData.name,
        validatedData.account_id || null,
        validatedData.contact_id || null,
        validatedData.owner_id || null,
        validatedData.stage || 'lead',
        validatedData.value || 0,
        validatedData.probability || 0,
        validatedData.expected_close_date || null,
        validatedData.currency || 'USD',
        validatedData.description || null,
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

// PUT /api/deals/:id - Update deal
router.put('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validatedData = createDealSchema.partial().parse(req.body);

    const existing = await queryOne('SELECT id FROM deals WHERE id = $1', [id]);
    if (!existing) {
      throw createError('Deal not found', 404);
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(validatedData).forEach(([key, value]) => {
      updates.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    if (updates.length === 0) {
      throw createError('No fields to update', 400);
    }

    // If stage is being updated to closed_won or closed_lost, set actual_close_date
    if (validatedData.stage === 'closed_won' || validatedData.stage === 'closed_lost') {
      updates.push('actual_close_date = CURRENT_DATE');
    }

    values.push(id);
    const result = await queryOne(
      `UPDATE deals SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    res.json({
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

// DELETE /api/deals/:id - Delete deal
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await queryOne('DELETE FROM deals WHERE id = $1 RETURNING id', [id]);

    if (!result) {
      throw createError('Deal not found', 404);
    }

    res.json({
      success: true,
      message: 'Deal deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

