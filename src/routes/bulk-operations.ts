import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';

const router = Router();

const bulkUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  updates: z.record(z.string(), z.any()),
});

// POST /api/bulk-operations/contacts/update - Bulk update contacts
router.post('/contacts/update', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = bulkUpdateSchema.parse(req.body);
    const { ids, updates } = validatedData;

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      updateFields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    if (updateFields.length === 0) {
      throw createError('No fields to update', 400);
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    const placeholders = ids.map((_, index) => `$${paramIndex + index}`).join(',');
    values.push(...ids);

    const result = await query(
      `UPDATE contacts 
       SET ${updateFields.join(', ')} 
       WHERE id IN (${placeholders})
       RETURNING id`,
      values
    );

    res.json({
      success: true,
      data: {
        updated: result.length,
        ids: result.map((r: any) => r.id),
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// POST /api/bulk-operations/contacts/delete - Bulk delete contacts
router.post('/contacts/delete', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw createError('ids must be a non-empty array', 400);
    }

    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');

    const result = await query(
      `DELETE FROM contacts WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );

    res.json({
      success: true,
      data: {
        deleted: result.length,
        ids: result.map((r: any) => r.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/bulk-operations/accounts/update - Bulk update accounts
router.post('/accounts/update', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = bulkUpdateSchema.parse(req.body);
    const { ids, updates } = validatedData;

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      updateFields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    if (updateFields.length === 0) {
      throw createError('No fields to update', 400);
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    const placeholders = ids.map((_, index) => `$${paramIndex + index}`).join(',');
    values.push(...ids);

    const result = await query(
      `UPDATE accounts 
       SET ${updateFields.join(', ')} 
       WHERE id IN (${placeholders})
       RETURNING id`,
      values
    );

    res.json({
      success: true,
      data: {
        updated: result.length,
        ids: result.map((r: any) => r.id),
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// POST /api/bulk-operations/accounts/delete - Bulk delete accounts
router.post('/accounts/delete', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw createError('ids must be a non-empty array', 400);
    }

    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');

    const result = await query(
      `DELETE FROM accounts WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );

    res.json({
      success: true,
      data: {
        deleted: result.length,
        ids: result.map((r: any) => r.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/bulk-operations/deals/update - Bulk update deals
router.post('/deals/update', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = bulkUpdateSchema.parse(req.body);
    const { ids, updates } = validatedData;

    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      updateFields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    if (updateFields.length === 0) {
      throw createError('No fields to update', 400);
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

    const placeholders = ids.map((_, index) => `$${paramIndex + index}`).join(',');
    values.push(...ids);

    const result = await query(
      `UPDATE deals 
       SET ${updateFields.join(', ')} 
       WHERE id IN (${placeholders})
       RETURNING id`,
      values
    );

    res.json({
      success: true,
      data: {
        updated: result.length,
        ids: result.map((r: any) => r.id),
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// POST /api/bulk-operations/deals/delete - Bulk delete deals
router.post('/deals/delete', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw createError('ids must be a non-empty array', 400);
    }

    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');

    const result = await query(
      `DELETE FROM deals WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );

    res.json({
      success: true,
      data: {
        deleted: result.length,
        ids: result.map((r: any) => r.id),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
