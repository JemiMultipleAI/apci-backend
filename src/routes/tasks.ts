import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { hasCompanyAccess, isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';

interface TaskQueryResult {
  id: string;
  title: string;
  description: string | null;
  assigned_to: string | null;
  related_to_type: string | null;
  related_to_id: string | null;
  due_date: Date | null;
  status: string;
  priority: string;
  created_at: Date;
  updated_at: Date;
  assigned_to_name: string | null;
}

const router = Router();

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  related_to_type: z.enum(['contact', 'account', 'deal']).optional().nullable(),
  related_to_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
});

// GET /api/tasks - List all tasks
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10', status, assigned_to, priority, company_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    // Validate UUID format if provided
    if (company_id && typeof company_id === 'string') {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(company_id).success) {
        return next(createError('Invalid company ID format', 400));
      }
    }
    
    // Get effective company ID for filtering
    const effectiveCompanyId = req.userCompanyId ?? 
      (req.user.companyId !== undefined ? req.user.companyId : null);
    
    // If super_admin and company_id provided, use it; otherwise use user's company
    const filterCompanyId = isSuperAdmin(req.user) 
      ? (company_id as string | undefined) || null
      : effectiveCompanyId;
    
    let whereClause = 'WHERE 1=1';
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Optimized: Use JOINs instead of subqueries for better performance
    if (filterCompanyId !== null) {
      whereClause += ` AND (
        u.account_id = $${paramIndex}
        OR (t.related_to_type = 'account' AND t.related_to_id = $${paramIndex})
        OR c.account_id = $${paramIndex}
        OR d.account_id = $${paramIndex}
      )`;
      params.push(filterCompanyId);
      paramIndex++;
    }

    if (status) {
      const statusStr = Array.isArray(status) ? status[0] : status;
      if (typeof statusStr === 'string') {
        whereClause += ` AND status = $${paramIndex}`;
        params.push(statusStr);
        paramIndex++;
      }
    }

    if (assigned_to) {
      const assignedToStr = Array.isArray(assigned_to) ? assigned_to[0] : assigned_to;
      if (typeof assignedToStr === 'string') {
        whereClause += ` AND assigned_to = $${paramIndex}`;
        params.push(assignedToStr);
        paramIndex++;
      }
    }

    if (priority) {
      const priorityStr = Array.isArray(priority) ? priority[0] : priority;
      if (typeof priorityStr === 'string') {
        whereClause += ` AND priority = $${paramIndex}`;
        params.push(priorityStr);
        paramIndex++;
      }
    }

    const tasks = await query<TaskQueryResult>(
      `SELECT t.*, 
        u.first_name || ' ' || u.last_name as assigned_to_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN contacts c ON t.related_to_type = 'contact' AND t.related_to_id = c.id
       LEFT JOIN deals d ON t.related_to_type = 'deal' AND t.related_to_id = d.id
       ${whereClause} 
       ORDER BY 
         CASE priority
           WHEN 'urgent' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
         END,
         t.due_date ASC NULLS LAST,
         t.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    // Count query needs to match the JOIN structure
    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT t.id) as count 
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN contacts c ON t.related_to_type = 'contact' AND t.related_to_id = c.id
       LEFT JOIN deals d ON t.related_to_type = 'deal' AND t.related_to_id = d.id
       ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: tasks,
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

// GET /api/tasks/:id - Get single task
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid task ID format', 400);
    }
    
    const task = await queryOne<TaskQueryResult>(
      `SELECT t.*, 
        u.first_name || ' ' || u.last_name as assigned_to_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.id = $1`,
      [id]
    );

    if (!task) {
      throw createError('Task not found', 404);
    }

    // Check company access using cached company_id
    const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
    
    if (!isSuperAdmin(req.user)) {
      let hasAccess = false;
      
      // Check by assigned_to user's company
      if (task.assigned_to) {
        const assignedUser = await queryOne<{ account_id: string | null }>(
          'SELECT account_id FROM users WHERE id = $1',
          [task.assigned_to]
        );
        if (assignedUser?.account_id === userCompanyId) {
          hasAccess = true;
        }
      }
      
      // Check by related entity's company
      if (!hasAccess && task.related_to_type && task.related_to_id) {
        if (task.related_to_type === 'account' && task.related_to_id === userCompanyId) {
          hasAccess = true;
        } else if (task.related_to_type === 'contact') {
          const contact = await queryOne<{ account_id: string | null }>(
            'SELECT account_id FROM contacts WHERE id = $1',
            [task.related_to_id]
          );
          if (contact?.account_id === userCompanyId) {
            hasAccess = true;
          }
        } else if (task.related_to_type === 'deal') {
          const deal = await queryOne<{ account_id: string | null }>(
            'SELECT account_id FROM deals WHERE id = $1',
            [task.related_to_id]
          );
          if (deal?.account_id === userCompanyId) {
            hasAccess = true;
          }
        }
      }
      
      if (!hasAccess) {
        logger.warn('Task access denied', { userId: req.user.userId, taskId: id, userCompanyId });
        throw createError('Forbidden: You do not have access to this task', 403);
      }
    }

    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/tasks - Create new task
router.post('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = createTaskSchema.parse(req.body);
    
    // Validate UUID format for related_to_id if provided
    if (validatedData.related_to_id) {
      const uuidSchema = z.string().uuid();
      if (!uuidSchema.safeParse(validatedData.related_to_id).success) {
        throw createError('Invalid related entity ID format', 400);
      }
      
      // Check company access for related entities
      if (!isSuperAdmin(req.user!) && validatedData.related_to_type) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user!);
        let hasAccess = false;
        
        if (validatedData.related_to_type === 'account' && validatedData.related_to_id === userCompanyId) {
          hasAccess = true;
        } else if (validatedData.related_to_type === 'contact') {
          const contact = await queryOne<{ account_id: string | null }>(
            'SELECT account_id FROM contacts WHERE id = $1',
            [validatedData.related_to_id]
          );
          if (contact?.account_id === userCompanyId) {
            hasAccess = true;
          }
        } else if (validatedData.related_to_type === 'deal') {
          const deal = await queryOne<{ account_id: string | null }>(
            'SELECT account_id FROM deals WHERE id = $1',
            [validatedData.related_to_id]
          );
          if (deal?.account_id === userCompanyId) {
            hasAccess = true;
          }
        }
        
        if (!hasAccess) {
          logger.warn('Task creation denied: Invalid company access', { userId: req.user!.userId, relatedToType: validatedData.related_to_type, relatedToId: validatedData.related_to_id, userCompanyId });
          throw createError('Forbidden: You can only create tasks for entities in your company', 403);
        }
      }
    }
    
    const result = await queryOne<TaskQueryResult>(
      `INSERT INTO tasks (
        title, description, assigned_to, related_to_type, related_to_id,
        due_date, status, priority
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        validatedData.title,
        validatedData.description || null,
        validatedData.assigned_to || null,
        validatedData.related_to_type || null,
        validatedData.related_to_id || null,
        validatedData.due_date || null,
        validatedData.status || 'pending',
        validatedData.priority || 'medium',
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

// PUT /api/tasks/:id - Update task
router.put('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validatedData = createTaskSchema.partial().parse(req.body);

    const existing = await queryOne('SELECT id FROM tasks WHERE id = $1', [id]);
    if (!existing) {
      throw createError('Task not found', 404);
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
      `UPDATE tasks SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
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

// DELETE /api/tasks/:id - Delete task
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await queryOne('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);

    if (!result) {
      throw createError('Task not found', 404);
    }

    res.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

