import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser, requireWriteAccess, requireDeleteAccess } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { hasCompanyAccess, isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { logger } from '../utils/logger';

interface ContactQueryResult {
  id: string;
  account_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile: string | null;
  job_title: string | null;
  department: string | null;
  owner_id: string | null;
  lifecycle_stage: string;
  notes: string | null;
  custom_fields: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

const router = Router();

// Helper function to normalize and validate mobile numbers
// Format: Must start with 61 followed by exactly 9 digits (11 digits total)
const normalizeMobile = (mobile: string | null | undefined): string | null => {
  if (!mobile || mobile.trim() === '') return null;
  
  // Remove all non-digit characters
  const digitsOnly = mobile.replace(/\D/g, '');
  
  // If empty after removing non-digits, return null
  if (digitsOnly.length === 0) return null;
  
  // If it starts with 0, replace with 61
  if (digitsOnly.startsWith('0')) {
    const withoutZero = digitsOnly.substring(1);
    if (withoutZero.length === 9) {
      return '61' + withoutZero;
    }
  }
  
  // If it starts with +61 (becomes 6161 after removing +), fix it
  if (digitsOnly.startsWith('6161') && digitsOnly.length === 13) {
    return '61' + digitsOnly.substring(2);
  }
  
  // If it already starts with 61, return as is
  if (digitsOnly.startsWith('61')) {
    return digitsOnly;
  }
  
  // If it's 9 digits (local number), add 61 prefix
  if (digitsOnly.length === 9) {
    return '61' + digitsOnly;
  }
  
  // Return as is (will be validated)
  return digitsOnly;
};

// Validation schemas
const createContactSchema = z.object({
  account_id: z.string().uuid().optional().nullable(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email().optional().nullable(),
  mobile: z.string()
    .optional()
    .nullable()
    .refine((val) => {
      if (!val || val.trim() === '') return true; // Allow null/empty
      const normalized = normalizeMobile(val);
      if (!normalized) return true; // Allow empty after normalization
      // Must be exactly 11 digits starting with 61
      return /^61\d{9}$/.test(normalized);
    }, {
      message: 'Mobile number must start with 61 followed by 9 digits (e.g., 61412345678). Do not use 0 or +61.',
    })
    .transform((val) => normalizeMobile(val)), // Normalize the value
  job_title: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  owner_id: z.string().uuid().optional().nullable(),
  lifecycle_stage: z.enum(['lead', 'qualified', 'customer', 'churned']).optional(),
  notes: z.string().optional().nullable(),
});

// GET /api/contacts - List all contacts
router.get('/', authenticate, enrichUser, applyCompanyFilter(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { 
      page = '1', 
      limit = '10', 
      account_id, 
      lifecycle_stage,
      lifecycle_stages,
      date_from,
      date_to,
      search
    } = req.query;
    
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

    if (account_id) {
      const accountIdStr = Array.isArray(account_id) ? account_id[0] : account_id;
      if (typeof accountIdStr === 'string') {
        whereClause += ` AND account_id = $${paramIndex}`;
        params.push(accountIdStr);
        paramIndex++;
      }
    }

    // Support both single lifecycle_stage and multiple lifecycle_stages
    if (lifecycle_stages) {
      const stages = Array.isArray(lifecycle_stages) 
        ? lifecycle_stages.map(s => typeof s === 'string' ? s : String(s))
        : (typeof lifecycle_stages === 'string' ? lifecycle_stages : String(lifecycle_stages)).split(',');
      if (stages.length > 0) {
        const placeholders = stages.map((_, i) => `$${paramIndex + i}`).join(',');
        whereClause += ` AND lifecycle_stage IN (${placeholders})`;
        params.push(...stages);
        paramIndex += stages.length;
      }
    } else if (lifecycle_stage) {
      const stageStr = Array.isArray(lifecycle_stage) ? lifecycle_stage[0] : lifecycle_stage;
      if (typeof stageStr === 'string') {
        whereClause += ` AND lifecycle_stage = $${paramIndex}`;
        params.push(stageStr);
        paramIndex++;
      }
    }

    // Date range filtering
    if (date_from) {
      const dateFromStr = Array.isArray(date_from) ? date_from[0] : date_from;
      if (typeof dateFromStr === 'string') {
        whereClause += ` AND created_at >= $${paramIndex}`;
        params.push(dateFromStr);
        paramIndex++;
      }
    }

    if (date_to) {
      const dateToStr = Array.isArray(date_to) ? date_to[0] : date_to;
      if (typeof dateToStr === 'string') {
        whereClause += ` AND created_at <= $${paramIndex}`;
        params.push(dateToStr + ' 23:59:59'); // Include the entire day
        paramIndex++;
      }
    }

    // Text search across name and email
    if (search) {
      const searchStr = Array.isArray(search) ? search[0] : search;
      if (typeof searchStr === 'string') {
        whereClause += ` AND (
          LOWER(first_name) LIKE $${paramIndex} OR 
          LOWER(last_name) LIKE $${paramIndex} OR 
          LOWER(email) LIKE $${paramIndex}
        )`;
        params.push(`%${searchStr.toLowerCase()}%`);
        paramIndex++;
      }
    }

    const contacts = await query<ContactQueryResult>(
      `SELECT * FROM contacts ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM contacts ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: contacts,
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

// GET /api/contacts/:id - Get single contact
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid contact ID format', 400);
    }
    
    const contact = await queryOne<ContactQueryResult>('SELECT * FROM contacts WHERE id = $1', [id]);

    if (!contact) {
      throw createError('Contact not found', 404);
    }

    // Check company access if contact has an account_id
    if (contact.account_id) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (!isSuperAdmin(req.user) && userCompanyId !== contact.account_id) {
        logger.warn('Contact access denied', { userId: req.user.userId, contactId: id, contactAccountId: contact.account_id, userCompanyId });
        throw createError('Forbidden: You do not have access to this contact', 403);
      }
    }

    res.json({
      success: true,
      data: contact,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/contacts - Create new contact
router.post('/', authenticate, enrichUser, requireWriteAccess(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = createContactSchema.parse(req.body);
    
    // Determine account_id: use provided value, or auto-assign user's company for non-super_admin users
    let accountId: string | null = validatedData.account_id || null;
    
    // Validate UUID format for account_id if provided
    if (accountId) {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(accountId).success) {
        throw createError('Invalid company ID format', 400);
      }
      
      // Check company access if account_id is provided
      if (!isSuperAdmin(req.user!)) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user!);
        if (userCompanyId !== accountId) {
          logger.warn('Contact creation denied: Invalid company', { userId: req.user!.userId, requestedCompanyId: accountId, userCompanyId });
          throw createError('Forbidden: You can only create contacts for your own company', 403);
        }
      }
    } else {
      // Auto-assign company if not provided and user is not super_admin
      if (!isSuperAdmin(req.user!)) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user!);
        if (userCompanyId) {
          accountId = userCompanyId;
          logger.debug('Auto-assigning contact to user company', { userId: req.user!.userId, companyId: userCompanyId });
        }
      }
    }
    
    const result = await queryOne<ContactQueryResult>(
      `INSERT INTO contacts (
        account_id, first_name, last_name, email, mobile,
        job_title, department, owner_id, lifecycle_stage, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        accountId,
        validatedData.first_name,
        validatedData.last_name,
        validatedData.email || null,
        validatedData.mobile || null,
        validatedData.job_title || null,
        validatedData.department || null,
        validatedData.owner_id || null,
        validatedData.lifecycle_stage || 'lead',
        validatedData.notes || null,
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

// PUT /api/contacts/:id - Update contact
router.put('/:id', authenticate, requireWriteAccess(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validatedData = createContactSchema.partial().parse(req.body);

    // Check if contact exists
    const existing = await queryOne('SELECT id FROM contacts WHERE id = $1', [id]);
    if (!existing) {
      throw createError('Contact not found', 404);
    }

    // Build update query dynamically
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
      `UPDATE contacts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
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

// DELETE /api/contacts/:id - Delete contact
router.delete('/:id', authenticate, requireDeleteAccess(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    
    const result = await queryOne('DELETE FROM contacts WHERE id = $1 RETURNING id', [id]);

    if (!result) {
      throw createError('Contact not found', 404);
    }

    res.json({
      success: true,
      message: 'Contact deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

