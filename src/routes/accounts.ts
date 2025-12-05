import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { hasCompanyAccess, isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { logger } from '../utils/logger';

interface AccountQueryResult {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  parent_account_id: string | null;
  owner_id: string | null;
  account_score: number;
  created_at: Date;
  updated_at: Date;
}

const router = Router();

const createAccountSchema = z.object({
  name: z.string().min(1),
  website: z.string().url().optional().nullable(),
  industry: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  postal_code: z.string().optional().nullable(),
  parent_account_id: z.string().uuid().optional().nullable(),
  owner_id: z.string().uuid().optional().nullable(),
});

// GET /api/accounts - List all accounts
router.get('/', authenticate, enrichUser, applyCompanyFilter('a'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10', owner_id, industry } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Apply company filter if available (for accounts, filter by account.id)
    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` AND a.id = $${paramIndex}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    if (owner_id) {
      const ownerIdStr = Array.isArray(owner_id) ? owner_id[0] : owner_id;
      if (typeof ownerIdStr === 'string') {
        whereClause += ` AND owner_id = $${paramIndex}`;
        params.push(ownerIdStr);
        paramIndex++;
      }
    }

    if (industry) {
      const industryStr = Array.isArray(industry) ? industry[0] : industry;
      if (typeof industryStr === 'string') {
        whereClause += ` AND industry = $${paramIndex}`;
        params.push(industryStr);
        paramIndex++;
      }
    }

    const accounts = await query<AccountQueryResult & { contact_count: number; deal_count: number; total_revenue: number }>(
      `SELECT a.*, 
        (SELECT COUNT(*) FROM contacts WHERE account_id = a.id) as contact_count,
        (SELECT COUNT(*) FROM deals WHERE account_id = a.id) as deal_count,
        (SELECT COALESCE(SUM(value), 0) FROM deals WHERE account_id = a.id AND stage = 'closed_won') as total_revenue
       FROM accounts a ${whereClause} 
       ORDER BY a.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM accounts a ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: accounts,
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

// GET /api/accounts/:id - Get single account
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid account ID format', 400);
    }
    
    const account = await queryOne<AccountQueryResult & { contact_count: number; deal_count: number; total_revenue: number }>(
      `SELECT a.*, 
        (SELECT COUNT(*) FROM contacts WHERE account_id = a.id) as contact_count,
        (SELECT COUNT(*) FROM deals WHERE account_id = a.id) as deal_count,
        (SELECT COALESCE(SUM(value), 0) FROM deals WHERE account_id = a.id AND stage = 'closed_won') as total_revenue
       FROM accounts a WHERE a.id = $1`,
      [id]
    );

    if (!account) {
      throw createError('Account not found', 404);
    }

    // Check company access using cached company_id
    const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
    if (!isSuperAdmin(req.user) && userCompanyId !== id) {
      logger.warn('Company access denied', { userId: req.user.userId, requestedCompanyId: id, userCompanyId });
      throw createError('Forbidden: You do not have access to this company', 403);
    }

    // Get child accounts
    const childAccounts = await query(
      'SELECT id, name FROM accounts WHERE parent_account_id = $1',
      [id]
    );

    res.json({
      success: true,
      data: { ...account, child_accounts: childAccounts },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts - Create new account
router.post('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Only super_admin can create accounts (companies)
    if (!isSuperAdmin(req.user!)) {
      throw createError('Forbidden: Only super_admin can create companies', 403);
    }
    
    const validatedData = createAccountSchema.parse(req.body);
    
    // Validate UUID format for parent_account_id and owner_id if provided
    if (validatedData.parent_account_id) {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(validatedData.parent_account_id).success) {
        throw createError('Invalid parent account ID format', 400);
      }
    }
    
    if (validatedData.owner_id) {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(validatedData.owner_id).success) {
        throw createError('Invalid owner ID format', 400);
      }
    }
    
    const result = await queryOne(
      `INSERT INTO accounts (
        name, website, industry, phone, email, address, city, state, 
        country, postal_code, parent_account_id, owner_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        validatedData.name,
        validatedData.website || null,
        validatedData.industry || null,
        validatedData.phone || null,
        validatedData.email || null,
        validatedData.address || null,
        validatedData.city || null,
        validatedData.state || null,
        validatedData.country || null,
        validatedData.postal_code || null,
        validatedData.parent_account_id || null,
        validatedData.owner_id || null,
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

// PUT /api/accounts/:id - Update account
router.put('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validatedData = createAccountSchema.partial().parse(req.body);

    const existing = await queryOne('SELECT id FROM accounts WHERE id = $1', [id]);
    if (!existing) {
      throw createError('Account not found', 404);
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

    values.push(id);
    const result = await queryOne(
      `UPDATE accounts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
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

// DELETE /api/accounts/:id - Delete account
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await queryOne('DELETE FROM accounts WHERE id = $1 RETURNING id', [id]);

    if (!result) {
      throw createError('Account not found', 404);
    }

    res.json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

