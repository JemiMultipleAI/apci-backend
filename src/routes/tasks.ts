import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { hasCompanyAccess, isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';

interface TaskQueryResult {
  id: string;
  subject: string; // title is stored as subject in activities
  description: string | null;
  assigned_to_user_id: string | null; // renamed from assigned_to
  related_to_type: string | null;
  related_to_id: string | null;
  due_date: Date | null;
  task_status: string; // renamed from status
  priority: string;
  created_at: Date;
  performed_by: string | null; // added from activities
  assigned_to_name: string | null;
  performed_by_name: string | null;
}

const router = Router();

const createTaskSchema = z.object({
  title: z.string().min(1), // Will be stored as subject
  description: z.string().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(), // Will be stored as assigned_to_user_id
  related_to_type: z.enum(['contact', 'account', 'deal']).optional().nullable(),
  related_to_id: z.string().uuid().optional().nullable(),
  due_date: z.string().optional().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
});

// GET /api/tasks - List all tasks (now queries activities WHERE type='task')
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
    
    let whereClause = "WHERE a.type = 'task'"; // Only get activities of type 'task'
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Optimized: Use JOINs instead of subqueries for better performance
    if (filterCompanyId !== null) {
      whereClause += ` AND (
        u.tenant_id = $${paramIndex}
        OR (a.related_to_type = 'account' AND a.related_to_id = $${paramIndex})
        OR c.tenant_id = $${paramIndex}
        OR d.tenant_id = $${paramIndex}
      )`;
      params.push(filterCompanyId);
      paramIndex++;
    }

    if (status) {
      const statusStr = Array.isArray(status) ? status[0] : status;
      if (typeof statusStr === 'string') {
        whereClause += ` AND a.task_status = $${paramIndex}`;
        params.push(statusStr);
        paramIndex++;
      }
    }

    if (assigned_to) {
      const assignedToStr = Array.isArray(assigned_to) ? assigned_to[0] : assigned_to;
      if (typeof assignedToStr === 'string') {
        whereClause += ` AND a.assigned_to_user_id = $${paramIndex}`;
        params.push(assignedToStr);
        paramIndex++;
      }
    }

    if (priority) {
      const priorityStr = Array.isArray(priority) ? priority[0] : priority;
      if (typeof priorityStr === 'string') {
        whereClause += ` AND a.priority = $${paramIndex}`;
        params.push(priorityStr);
        paramIndex++;
      }
    }

    const tasks = await query<TaskQueryResult>(
      `SELECT 
        a.id,
        a.subject,
        a.description,
        a.assigned_to_user_id,
        a.related_to_type,
        a.related_to_id,
        a.due_date,
        a.task_status,
        a.priority,
        a.created_at,
        a.performed_by,
        assigned_user.first_name || ' ' || assigned_user.last_name as assigned_to_name,
        performed_user.first_name || ' ' || performed_user.last_name as performed_by_name
       FROM activities a
       LEFT JOIN users assigned_user ON a.assigned_to_user_id = assigned_user.id
       LEFT JOIN users performed_user ON a.performed_by = performed_user.id
       LEFT JOIN contacts c ON a.related_to_type = 'contact' AND a.related_to_id = c.id
       LEFT JOIN deals d ON a.related_to_type = 'deal' AND a.related_to_id = d.id
       LEFT JOIN users u ON a.performed_by = u.id
       ${whereClause} 
       ORDER BY 
         CASE a.priority
           WHEN 'urgent' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
         END,
         a.due_date ASC NULLS LAST,
         a.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    // Count query needs to match the JOIN structure
    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT a.id) as count 
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       LEFT JOIN contacts c ON a.related_to_type = 'contact' AND a.related_to_id = c.id
       LEFT JOIN deals d ON a.related_to_type = 'deal' AND a.related_to_id = d.id
       ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    // Transform to match old Task interface format for backward compatibility
    const transformedTasks = tasks.map(t => ({
      id: t.id,
      title: t.subject,
      description: t.description,
      assigned_to: t.assigned_to_user_id,
      related_to_type: t.related_to_type,
      related_to_id: t.related_to_id,
      due_date: t.due_date,
      status: t.task_status,
      priority: t.priority,
      created_at: t.created_at,
      assigned_to_name: t.assigned_to_name,
      performed_by: t.performed_by,
      performed_by_name: t.performed_by_name,
    }));

    res.json({
      success: true,
      data: transformedTasks,
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

// GET /api/tasks/:id - Get single task (now queries activities WHERE type='task')
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
      `SELECT 
        a.id,
        a.subject,
        a.description,
        a.assigned_to_user_id,
        a.related_to_type,
        a.related_to_id,
        a.due_date,
        a.task_status,
        a.priority,
        a.created_at,
        a.performed_by,
        assigned_user.first_name || ' ' || assigned_user.last_name as assigned_to_name,
        performed_user.first_name || ' ' || performed_user.last_name as performed_by_name
       FROM activities a
       LEFT JOIN users assigned_user ON a.assigned_to_user_id = assigned_user.id
       LEFT JOIN users performed_user ON a.performed_by = performed_user.id
       WHERE a.id = $1 AND a.type = 'task'`,
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
      if (task.assigned_to_user_id) {
        const assignedUser = await queryOne<{ tenant_id: string | null }>(
          'SELECT tenant_id FROM users WHERE id = $1',
          [task.assigned_to_user_id]
        );
        if (assignedUser?.tenant_id === userCompanyId) {
          hasAccess = true;
        }
      }
      
      // Check by related entity's company
      if (!hasAccess && task.related_to_type && task.related_to_id) {
        if (task.related_to_type === 'account' && task.related_to_id === userCompanyId) {
          hasAccess = true;
        } else if (task.related_to_type === 'contact') {
          const contact = await queryOne<{ tenant_id: string | null }>(
            'SELECT tenant_id FROM contacts WHERE id = $1',
            [task.related_to_id]
          );
          if (contact?.tenant_id === userCompanyId) {
            hasAccess = true;
          }
        } else if (task.related_to_type === 'deal') {
          const deal = await queryOne<{ tenant_id: string | null }>(
            'SELECT tenant_id FROM deals WHERE id = $1',
            [task.related_to_id]
          );
          if (deal?.tenant_id === userCompanyId) {
            hasAccess = true;
          }
        }
      }
      
      if (!hasAccess) {
        logger.warn('Task access denied', { userId: req.user.userId, taskId: id, userCompanyId });
        throw createError('Forbidden: You do not have access to this task', 403);
      }
    }

    // Transform to match old Task interface format
    const transformedTask = {
      id: task.id,
      title: task.subject,
      description: task.description,
      assigned_to: task.assigned_to_user_id,
      related_to_type: task.related_to_type,
      related_to_id: task.related_to_id,
      due_date: task.due_date,
      status: task.task_status,
      priority: task.priority,
      created_at: task.created_at,
      assigned_to_name: task.assigned_to_name,
      performed_by: task.performed_by,
      performed_by_name: task.performed_by_name,
    };

    res.json({
      success: true,
      data: transformedTask,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/tasks - Create new task (now creates activity with type='task')
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
          const contact = await queryOne<{ tenant_id: string | null }>(
            'SELECT tenant_id FROM contacts WHERE id = $1',
            [validatedData.related_to_id]
          );
          if (contact?.tenant_id === userCompanyId) {
            hasAccess = true;
          }
        } else if (validatedData.related_to_type === 'deal') {
          const deal = await queryOne<{ tenant_id: string | null }>(
            'SELECT tenant_id FROM deals WHERE id = $1',
            [validatedData.related_to_id]
          );
          if (deal?.tenant_id === userCompanyId) {
            hasAccess = true;
          }
        }
        
        if (!hasAccess) {
          logger.warn('Task creation denied: Invalid company access', { userId: req.user!.userId, relatedToType: validatedData.related_to_type, relatedToId: validatedData.related_to_id, userCompanyId });
          throw createError('Forbidden: You can only create tasks for entities in your company', 403);
        }
      }
    }
    
    // Get tenant_id for activity
    let tenantId: string | null = null;
    if (!isSuperAdmin(req.user!)) {
      tenantId = req.userCompanyId ?? await getUserCompanyId(req.user!);
    }

    // Create activity with type='task'
    const result = await queryOne<TaskQueryResult>(
      `INSERT INTO activities (
        type, subject, description, assigned_to_user_id, related_to_type, related_to_id,
        due_date, task_status, priority, performed_by, tenant_id
      ) VALUES ('task', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, subject, description, assigned_to_user_id, related_to_type, related_to_id,
        due_date, task_status, priority, created_at, performed_by`,
      [
        validatedData.title, // Store title as subject
        validatedData.description || null,
        validatedData.assigned_to || null, // Store as assigned_to_user_id
        validatedData.related_to_type || null,
        validatedData.related_to_id || null,
        validatedData.due_date || null,
        validatedData.status || 'pending', // Store as task_status
        validatedData.priority || 'medium',
        req.user?.userId || null,
        tenantId,
      ]
    );

    // Get assigned user name if applicable
    let assignedToName = null;
    if (result?.assigned_to_user_id) {
      const assignedUser = await queryOne<{ first_name: string | null; last_name: string | null }>(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [result.assigned_to_user_id]
      );
      if (assignedUser) {
        assignedToName = [assignedUser.first_name, assignedUser.last_name].filter(Boolean).join(' ') || null;
      }
    }

    // Transform to match old Task interface format
    const transformedTask = {
      id: result!.id,
      title: result!.subject,
      description: result!.description,
      assigned_to: result!.assigned_to_user_id,
      related_to_type: result!.related_to_type,
      related_to_id: result!.related_to_id,
      due_date: result!.due_date,
      status: result!.task_status,
      priority: result!.priority,
      created_at: result!.created_at,
      assigned_to_name: assignedToName,
    };

    res.status(201).json({
      success: true,
      data: transformedTask,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// PUT /api/tasks/:id - Update task (now updates activity with type='task')
router.put('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validatedData = createTaskSchema.partial().parse(req.body);

    const existing = await queryOne('SELECT id FROM activities WHERE id = $1 AND type = \'task\'', [id]);
    if (!existing) {
      throw createError('Task not found', 404);
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Map old field names to new activity field names
    Object.entries(validatedData).forEach(([key, value]) => {
      if (key === 'title') {
        updates.push(`subject = $${paramIndex++}`);
        values.push(value);
      } else if (key === 'assigned_to') {
        updates.push(`assigned_to_user_id = $${paramIndex++}`);
        values.push(value);
      } else if (key === 'status') {
        updates.push(`task_status = $${paramIndex++}`);
        values.push(value);
      } else {
        updates.push(`${key} = $${paramIndex++}`);
        values.push(value);
      }
    });

    if (updates.length === 0) {
      throw createError('No fields to update', 400);
    }

    values.push(id);
    const result = await queryOne<TaskQueryResult>(
      `UPDATE activities 
       SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $${paramIndex} AND type = 'task'
       RETURNING id, subject, description, assigned_to_user_id, related_to_type, related_to_id,
         due_date, task_status, priority, created_at, performed_by`,
      values
    );

    // Get assigned user name
    let assignedToName = null;
    if (result?.assigned_to_user_id) {
      const assignedUser = await queryOne<{ first_name: string | null; last_name: string | null }>(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [result.assigned_to_user_id]
      );
      if (assignedUser) {
        assignedToName = [assignedUser.first_name, assignedUser.last_name].filter(Boolean).join(' ') || null;
      }
    }

    // Transform to match old Task interface format
    const transformedTask = {
      id: result!.id,
      title: result!.subject,
      description: result!.description,
      assigned_to: result!.assigned_to_user_id,
      related_to_type: result!.related_to_type,
      related_to_id: result!.related_to_id,
      due_date: result!.due_date,
      status: result!.task_status,
      priority: result!.priority,
      created_at: result!.created_at,
      assigned_to_name: assignedToName,
    };

    res.json({
      success: true,
      data: transformedTask,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/tasks/:id - Delete task (now deletes activity with type='task')
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await queryOne('DELETE FROM activities WHERE id = $1 AND type = \'task\' RETURNING id', [id]);

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
