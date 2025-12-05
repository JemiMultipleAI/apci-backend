import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';

const router = Router();

const createTemplateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['email', 'sms']),
  subject: z.string().optional().nullable(),
  body: z.string().min(1),
  variables: z.array(z.string()).optional(),
});

// GET /api/templates - List all templates
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type } = req.query;
    let whereClause = '';
    const params: any[] = [];

    if (type) {
      whereClause = 'WHERE type = $1';
      params.push(type);
    }

    const templates = await query(
      `SELECT * FROM templates ${whereClause} ORDER BY created_at DESC`,
      params
    );

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/templates/:id - Get single template
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const template = await queryOne('SELECT * FROM templates WHERE id = $1', [id]);

    if (!template) {
      throw createError('Template not found', 404);
    }

    res.json({
      success: true,
      data: template,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/templates - Create new template
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = createTemplateSchema.parse(req.body);
    const userId = req.user?.userId;
    
    const result = await queryOne(
      `INSERT INTO templates (name, type, subject, body, variables, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        validatedData.name,
        validatedData.type,
        validatedData.subject || null,
        validatedData.body,
        validatedData.variables || [],
        userId || null,
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

// PUT /api/templates/:id - Update template
router.put('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validatedData = createTemplateSchema.partial().parse(req.body);

    const existing = await queryOne('SELECT id FROM templates WHERE id = $1', [id]);
    if (!existing) {
      throw createError('Template not found', 404);
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
      `UPDATE templates SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
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

// DELETE /api/templates/:id - Delete template
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await queryOne('DELETE FROM templates WHERE id = $1 RETURNING id', [id]);

    if (!result) {
      throw createError('Template not found', 404);
    }

    res.json({
      success: true,
      message: 'Template deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

