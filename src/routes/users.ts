import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import bcrypt from 'bcryptjs';
import { isSuperAdmin, getEffectiveCompanyId, getUserCompanyId } from '../utils/companyAccess';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { logger } from '../utils/logger';

interface UserQueryResult {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  is_active: boolean;
  tenant_id: string | null; // Updated: account_id → tenant_id
  created_at: Date;
  updated_at: Date;
}

const router = Router();

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role: z.enum(['super_admin', 'admin', 'manager', 'sales_rep', 'viewer']).optional(),
  is_active: z.boolean().optional(),
  tenant_id: z.string().uuid().optional().nullable(), // Updated: account_id → tenant_id
});

const updateUserSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  role: z.enum(['super_admin', 'admin', 'manager', 'sales_rep', 'viewer']).optional(),
  is_active: z.boolean().optional(),
  tenant_id: z.string().uuid().optional().nullable(), // Updated: account_id → tenant_id
});

// GET /api/users - List all users (admin/manager/super_admin only)
router.get('/', authenticate, enrichUser, authorize('super_admin', 'admin', 'manager'), applyCompanyFilter(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10', role, is_active } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: (string | number | boolean)[] = [];
    let paramIndex = 1;

    // Apply company filter if available
    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` ${req.companyFilter.clause}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    if (role) {
      whereClause += ` AND role = $${paramIndex}`;
      params.push(role as string);
      paramIndex++;
    }

    if (is_active !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`;
      params.push(is_active === 'true');
      paramIndex++;
    }

    const users = await query<UserQueryResult>(
      `SELECT id, email, first_name, last_name, role, is_active, tenant_id, created_at, updated_at
       FROM users ${whereClause} 
       ORDER BY created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM users ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: users.map((user) => ({
        ...user,
        company_id: user.tenant_id || null, // Keep company_id for backward compatibility
      })),
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

// POST /api/users - Create new user (super_admin only)
router.post('/', authenticate, authorize('super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const validatedData = createUserSchema.parse(req.body);

    // Validate tenant assignment
    if (validatedData.role === 'super_admin') {
      // Super_admin cannot have a tenant
      if (validatedData.tenant_id !== null && validatedData.tenant_id !== undefined) {
        throw createError('Super admin cannot be assigned to a tenant', 400);
      }
    } else {
      // Non-super_admin roles must have a tenant
      if (!validatedData.tenant_id) {
        throw createError('Tenant assignment is required for non-super_admin roles', 400);
      }
    }

    // Only super_admin can create other super_admins
    if (validatedData.role === 'super_admin' && !isSuperAdmin(req.user)) {
      throw createError('Only super_admin can create super_admin users', 403);
    }

    // Check if user already exists
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [validatedData.email]);
    if (existing) {
      throw createError('User with this email already exists', 409);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(validatedData.password, 10);

    // Validate UUID format for tenant_id if provided
    if (validatedData.tenant_id) {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(validatedData.tenant_id).success) {
        throw createError('Invalid tenant ID format', 400);
      }
    }

    // Create user
    const user = await queryOne<UserQueryResult>(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, first_name, last_name, role, is_active, tenant_id, created_at, updated_at`,
      [
        validatedData.email,
        passwordHash,
        validatedData.first_name || null,
        validatedData.last_name || null,
        validatedData.role || 'viewer',
        validatedData.is_active !== undefined ? validatedData.is_active : true,
        validatedData.tenant_id || null,
      ]
    );

    if (!user) {
      throw createError('Failed to create user', 500);
    }

    res.status(201).json({
      success: true,
      data: {
        ...user,
        company_id: user.tenant_id || null, // Keep company_id for backward compatibility
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// GET /api/users/:id - Get single user
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    const currentUserId = req.user.userId;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid user ID format', 400);
    }

    const user = await queryOne<UserQueryResult>(
      'SELECT id, email, first_name, last_name, role, is_active, tenant_id, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );

    if (!user) {
      throw createError('User not found', 404);
    }

    // Users can view their own profile, or if they're super_admin/admin/manager
    // For non-super_admin, check tenant access
    if (id !== currentUserId && !isSuperAdmin(req.user)) {
      // Check if user has access to view this employee (same tenant)
      const userTenantId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (user.tenant_id && userTenantId !== user.tenant_id) {
        logger.warn('User access denied', { userId: req.user.userId, requestedUserId: id, requestedUserTenantId: user.tenant_id, userTenantId });
        throw createError('Forbidden: You do not have access to this user', 403);
      }
    }

    res.json({
      success: true,
      data: {
        ...user,
        company_id: user.tenant_id || null, // Keep company_id for backward compatibility
      },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/users/:id - Update user
router.put('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    const currentUserId = req.user.userId;
    const validatedData = updateUserSchema.parse(req.body);
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid user ID format', 400);
    }
    
    // Validate UUID format for tenant_id if provided
    if (validatedData.tenant_id) {
      if (!uuidSchema.safeParse(validatedData.tenant_id).success) {
        throw createError('Invalid tenant ID format', 400);
      }
    }

    // Users can only update their own profile (except role/is_active/tenant_id), unless they're super_admin
    if (id !== currentUserId && !isSuperAdmin(req.user)) {
      throw createError('Forbidden', 403);
    }

    // Only super_admin can change role, is_active, and tenant_id
    if ((validatedData.role !== undefined || validatedData.is_active !== undefined || validatedData.tenant_id !== undefined) && !isSuperAdmin(req.user)) {
      throw createError('Only super_admin can change role, active status, or tenant assignment', 403);
    }

    // Validate tenant assignment if role is being changed
    if (validatedData.role !== undefined) {
      if (validatedData.role === 'super_admin') {
        // Super_admin cannot have a tenant
        if (validatedData.tenant_id !== null && validatedData.tenant_id !== undefined) {
          throw createError('Super admin cannot be assigned to a tenant', 400);
        }
      } else {
        // Non-super_admin roles must have a tenant
        const existing = await queryOne<{ tenant_id: string | null }>('SELECT tenant_id FROM users WHERE id = $1', [id]);
        const finalTenantId = validatedData.tenant_id !== undefined ? validatedData.tenant_id : existing?.tenant_id;
        if (!finalTenantId) {
          throw createError('Tenant assignment is required for non-super_admin roles', 400);
        }
      }
    }

    // Only super_admin can create/update other super_admins
    if (validatedData.role === 'super_admin' && !isSuperAdmin(req.user)) {
      throw createError('Only super_admin can create or update super_admin users', 403);
    }

    const existing = await queryOne('SELECT id FROM users WHERE id = $1', [id]);
    if (!existing) {
      throw createError('User not found', 404);
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(validatedData).forEach(([key, value]) => {
      if (key === 'tenant_id') {
        updates.push(`tenant_id = $${paramIndex}`);
        values.push(value);
      } else {
        updates.push(`${key} = $${paramIndex}`);
        values.push(value);
      }
      paramIndex++;
    });

    if (updates.length === 0) {
      throw createError('No fields to update', 400);
    }

    values.push(id);
    const result = await queryOne<UserQueryResult>(
      `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING id, email, first_name, last_name, role, is_active, tenant_id, created_at, updated_at`,
      values
    );

    if (!result) {
      throw createError('User not found', 404);
    }

    res.json({
      success: true,
      data: {
        ...result,
        company_id: result.tenant_id || null, // Keep company_id for backward compatibility
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/users/:id - Delete user (super_admin only)
router.delete('/:id', authenticate, authorize('super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user?.userId;

    // Prevent self-deletion
    if (id === currentUserId) {
      throw createError('You cannot delete your own account', 400);
    }

    const existing = await queryOne('SELECT id FROM users WHERE id = $1', [id]);
    if (!existing) {
      throw createError('User not found', 404);
    }

    await query('DELETE FROM users WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

