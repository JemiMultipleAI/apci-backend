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
  subject: z.string().optional().nullable(), // For tasks, this is the title
  description: z.string().optional().nullable(),
  related_to_type: z.enum(['contact', 'account', 'deal']).optional().nullable(),
  related_to_id: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.any()).optional(),
  // Task-specific fields (only used when type='task')
  due_date: z.string().optional().nullable(), // ISO date string
  assigned_to_user_id: z.string().uuid().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  task_status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
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
    
    // Get tenant_id from related entity
    let tenantId: string | null = null;
    if (validatedData.related_to_type && validatedData.related_to_id) {
      if (validatedData.related_to_type === 'contact') {
        const contact = await queryOne<{ tenant_id: string | null }>(
          'SELECT tenant_id FROM contacts WHERE id = $1',
          [validatedData.related_to_id]
        );
        tenantId = contact?.tenant_id || null;
      } else if (validatedData.related_to_type === 'account') {
        // For accounts (customer_companies), get tenant_id from the related contact or deal
        // This is a simplified check - in practice you might need to join with customer_companies
        tenantId = null; // Will use user's tenant_id as fallback
      } else if (validatedData.related_to_type === 'deal') {
        const deal = await queryOne<{ tenant_id: string | null }>(
          'SELECT tenant_id FROM deals WHERE id = $1',
          [validatedData.related_to_id]
        );
        tenantId = deal?.tenant_id || null;
      }

      // Verify company access for non-super_admin users
      if (!isSuperAdmin(req.user) && tenantId) {
        const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
        if (userCompanyId !== tenantId) {
          return next(createError('Forbidden: You do not have access to this company', 403));
        }
      }
    } else {
      // If no related entity, use user's tenant
      if (!isSuperAdmin(req.user)) {
        tenantId = req.userCompanyId ?? await getUserCompanyId(req.user);
      }
    }
    
    // Build INSERT query with optional task-specific fields
    const isTask = validatedData.type === 'task';
    const fields = [
      'type', 'subject', 'description', 'related_to_type', 'related_to_id',
      'performed_by', 'metadata', 'tenant_id'
    ];
    const values: any[] = [
      validatedData.type,
      validatedData.subject || null,
      validatedData.description || null,
      validatedData.related_to_type || null,
      validatedData.related_to_id || null,
      userId || null,
      JSON.stringify(validatedData.metadata || {}),
      tenantId,
    ];

    // Add task-specific fields if this is a task
    if (isTask) {
      fields.push('due_date', 'assigned_to_user_id', 'priority', 'task_status');
      values.push(
        validatedData.due_date || null,
        validatedData.assigned_to_user_id || null,
        validatedData.priority || 'medium',
        validatedData.task_status || 'pending'
      );
    }

    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const result = await queryOne(
      `INSERT INTO activities (${fields.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      values
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

// GET /api/activities/conversations - Get activities grouped into conversations
router.get('/conversations', authenticate, enrichUser, applyCompanyFilter('a'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '20', type, contact_id } = req.query;
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

    // Filter by type (email or sms only for conversations)
    if (type && (type === 'email' || type === 'sms')) {
      whereClause += ` AND a.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    } else {
      // Default to email and sms only
      whereClause += ` AND a.type IN ('email', 'sms')`;
    }

    // Filter by contact if provided
    if (contact_id) {
      whereClause += ` AND a.related_to_type = 'contact' AND a.related_to_id = $${paramIndex}`;
      params.push(contact_id);
      paramIndex++;
    }

    // Get activities with contact information
    const activities = await query(
      `SELECT 
        a.*,
        u.first_name || ' ' || u.last_name as performed_by_name,
        c.first_name as contact_first_name,
        c.last_name as contact_last_name,
        c.email as contact_email,
        c.mobile as contact_mobile
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       LEFT JOIN contacts c ON a.related_to_type = 'contact' AND a.related_to_id = c.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    // Group activities into conversations
    // A conversation is defined by: contact_id + channel (email/sms)
    const conversationsMap = new Map<string, {
      contact_id: string | null;
      contact_name: string;
      contact_email: string | null;
      contact_mobile: string | null;
      channel: string;
      messages: any[];
      last_activity: Date;
    }>();

    for (const activity of activities) {
      const contactId = activity.related_to_id || 'unknown';
      const channel = activity.type; // email or sms
      const conversationKey = `${contactId}_${channel}`;

      if (!conversationsMap.has(conversationKey)) {
        conversationsMap.set(conversationKey, {
          contact_id: activity.related_to_id,
          contact_name: activity.contact_first_name && activity.contact_last_name
            ? `${activity.contact_first_name} ${activity.contact_last_name}`
            : activity.contact_email || activity.contact_mobile || 'Unknown Contact',
          contact_email: activity.contact_email,
          contact_mobile: activity.contact_mobile,
          channel: channel,
          messages: [],
          last_activity: new Date(activity.created_at),
        });
      }

      const conversation = conversationsMap.get(conversationKey)!;
      const isInbound = activity.metadata?.inbound === true;
      const isOutbound = activity.metadata?.outbound === true || !isInbound;

      conversation.messages.push({
        id: activity.id,
        type: activity.type,
        subject: activity.subject,
        description: activity.description,
        performed_by_name: activity.performed_by_name,
        created_at: activity.created_at,
        metadata: activity.metadata,
        direction: isInbound ? 'inbound' : 'outbound',
        ai_generated: activity.metadata?.ai_generated === true,
      });

      // Update last activity if this is more recent
      const activityDate = new Date(activity.created_at);
      if (activityDate > conversation.last_activity) {
        conversation.last_activity = activityDate;
      }
    }

    // Convert map to array and sort by last activity
    const conversations = Array.from(conversationsMap.values())
      .map(conv => ({
        ...conv,
        messages: conv.messages.sort((a, b) => 
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ),
      }))
      .sort((a, b) => b.last_activity.getTime() - a.last_activity.getTime());

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT a.related_to_id || '_' || a.type) as count 
       FROM activities a 
       ${whereClause} 
       AND a.related_to_type = 'contact' 
       AND a.type IN ('email', 'sms')`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: conversations,
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

export default router;

