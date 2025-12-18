import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z } from 'zod';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';

const router = Router();

const createContactGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
});

const updateContactGroupSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
});

// GET /api/contact-groups - List all contact groups
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // Apply company filtering for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId) {
        whereClause += ` AND cg.account_id = $${paramIndex}`;
        params.push(userCompanyId);
        paramIndex++;
      }
    }

    const groups = await query(
      `SELECT 
        cg.*,
        u.first_name || ' ' || u.last_name as created_by_name,
        COUNT(DISTINCT cgm.contact_id) as member_count
       FROM contact_groups cg
       LEFT JOIN users u ON cg.created_by = u.id
       LEFT JOIN contact_group_members cgm ON cg.id = cgm.contact_group_id
       ${whereClause}
       GROUP BY cg.id, u.first_name, u.last_name
       ORDER BY cg.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM contact_groups cg ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: groups.map(g => ({
        ...g,
        member_count: parseInt(g.member_count || '0', 10),
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

// GET /api/contact-groups/:id - Get single contact group
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;

    const group = await queryOne(
      `SELECT 
        cg.*,
        u.first_name || ' ' || u.last_name as created_by_name,
        COUNT(DISTINCT cgm.contact_id) as member_count
       FROM contact_groups cg
       LEFT JOIN users u ON cg.created_by = u.id
       LEFT JOIN contact_group_members cgm ON cg.id = cgm.contact_group_id
       WHERE cg.id = $1
       GROUP BY cg.id, u.first_name, u.last_name`,
      [id]
    );

    if (!group) {
      return next(createError('Contact group not found', 404));
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId && group.account_id !== userCompanyId) {
        return next(createError('Access denied', 403));
      }
    }

    res.json({
      success: true,
      data: {
        ...group,
        member_count: parseInt(group.member_count || '0', 10),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/contact-groups - Create new contact group
router.post('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const validatedData = createContactGroupSchema.parse(req.body);
    const userId = req.user?.userId;
    const userCompanyId = req.userCompanyId ?? (req.user ? await getUserCompanyId(req.user) : null);

    if (!userCompanyId && !isSuperAdmin(req.user)) {
      return next(createError('Company ID required for non-super-admin users', 400));
    }

    const result = await queryOne(
      `INSERT INTO contact_groups (name, description, account_id, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        validatedData.name,
        validatedData.description || null,
        userCompanyId,
        userId || null,
      ]
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// PUT /api/contact-groups/:id - Update contact group
router.put('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    const validatedData = updateContactGroupSchema.parse(req.body);

    // Check if group exists and user has access
    const existingGroup = await queryOne('SELECT * FROM contact_groups WHERE id = $1', [id]);
    if (!existingGroup) {
      return next(createError('Contact group not found', 404));
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId && existingGroup.account_id !== userCompanyId) {
        return next(createError('Access denied', 403));
      }
    }

    const updateFields: string[] = [];
    const updateValues: any[] = [];
    let paramIndex = 1;

    if (validatedData.name !== undefined) {
      updateFields.push(`name = $${paramIndex++}`);
      updateValues.push(validatedData.name);
    }
    if (validatedData.description !== undefined) {
      updateFields.push(`description = $${paramIndex++}`);
      updateValues.push(validatedData.description);
    }

    if (updateFields.length === 0) {
      return next(createError('No fields to update', 400));
    }

    updateValues.push(id);

    const result = await queryOne(
      `UPDATE contact_groups 
       SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING *`,
      updateValues
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/contact-groups/:id - Delete contact group
router.delete('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;

    // Check if group exists and user has access
    const existingGroup = await queryOne('SELECT * FROM contact_groups WHERE id = $1', [id]);
    if (!existingGroup) {
      return next(createError('Contact group not found', 404));
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId && existingGroup.account_id !== userCompanyId) {
        return next(createError('Access denied', 403));
      }
    }

    await query('DELETE FROM contact_groups WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'Contact group deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/contact-groups/contacts/:contactId/groups - Get groups for a contact
// NOTE: This route must come BEFORE /:id/contacts to avoid route conflicts
router.get('/contacts/:contactId/groups', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { contactId } = req.params;

    // Check if contact exists
    const contact = await queryOne('SELECT * FROM contacts WHERE id = $1', [contactId]);
    if (!contact) {
      return next(createError('Contact not found', 404));
    }

    const groups = await query(
      `SELECT cg.*, cgm.added_at as added_at
       FROM contact_groups cg
       INNER JOIN contact_group_members cgm ON cg.id = cgm.contact_group_id
       WHERE cgm.contact_id = $1
       ORDER BY cg.name`,
      [contactId]
    );

    res.json({
      success: true,
      data: groups,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/contact-groups/contacts/:contactId/groups - Add contact to groups (bulk)
// NOTE: This route must come BEFORE /:id/contacts to avoid route conflicts
router.post('/contacts/:contactId/groups', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { contactId } = req.params;
    const { group_ids } = z.object({
      group_ids: z.array(z.string().uuid()),
    }).parse(req.body);

    const userId = req.user?.userId;

    // Check if contact exists
    const contact = await queryOne('SELECT * FROM contacts WHERE id = $1', [contactId]);
    if (!contact) {
      return next(createError('Contact not found', 404));
    }

    if (group_ids.length === 0) {
      return next(createError('No group IDs provided', 400));
    }

    // Insert groups (ignore duplicates)
    const placeholders = group_ids.map((_, index) => `($${index + 1}, $${group_ids.length + 1}, CURRENT_TIMESTAMP, $${group_ids.length + 2})`).join(', ');
    const values: any[] = [...group_ids, contactId, userId || null];

    await query(
      `INSERT INTO contact_group_members (contact_group_id, contact_id, added_at, added_by)
       VALUES ${placeholders}
       ON CONFLICT (contact_id, contact_group_id) DO NOTHING`,
      values
    );

    res.json({
      success: true,
      message: `Added contact to ${group_ids.length} group(s)`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/contact-groups/contacts/:contactId/groups/:groupId - Remove contact from group
// NOTE: This route must come BEFORE /:id/contacts to avoid route conflicts
router.delete('/contacts/:contactId/groups/:groupId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { contactId, groupId } = req.params;

    // Check if contact exists
    const contact = await queryOne('SELECT * FROM contacts WHERE id = $1', [contactId]);
    if (!contact) {
      return next(createError('Contact not found', 404));
    }

    await query(
      'DELETE FROM contact_group_members WHERE contact_id = $1 AND contact_group_id = $2',
      [contactId, groupId]
    );

    res.json({
      success: true,
      message: 'Contact removed from group',
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/contact-groups/:id/contacts - Get contacts in a group
router.get('/:id/contacts', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    const { page = '1', limit = '50' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    // Check if group exists and user has access
    const existingGroup = await queryOne('SELECT * FROM contact_groups WHERE id = $1', [id]);
    if (!existingGroup) {
      return next(createError('Contact group not found', 404));
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId && existingGroup.account_id !== userCompanyId) {
        return next(createError('Access denied', 403));
      }
    }

    const contacts = await query(
      `SELECT c.*, cgm.added_at as added_to_group_at
       FROM contacts c
       INNER JOIN contact_group_members cgm ON c.id = cgm.contact_id
       WHERE cgm.contact_group_id = $1
       ORDER BY cgm.added_at DESC
       LIMIT $2 OFFSET $3`,
      [id, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count 
       FROM contact_group_members 
       WHERE contact_group_id = $1`,
      [id]
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

// POST /api/contact-groups/:id/contacts - Add contacts to group (bulk)
router.post('/:id/contacts', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    const { contact_ids } = z.object({
      contact_ids: z.array(z.string().uuid()),
    }).parse(req.body);

    const userId = req.user?.userId;

    // Check if group exists and user has access
    const existingGroup = await queryOne('SELECT * FROM contact_groups WHERE id = $1', [id]);
    if (!existingGroup) {
      return next(createError('Contact group not found', 404));
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId && existingGroup.account_id !== userCompanyId) {
        return next(createError('Access denied', 403));
      }
    }

    if (contact_ids.length === 0) {
      return next(createError('No contact IDs provided', 400));
    }

    // Insert contacts (ignore duplicates)
    const placeholders = contact_ids.map((_, index) => `($1, $${index + 2}, CURRENT_TIMESTAMP, $${contact_ids.length + 2})`).join(', ');
    const values: any[] = [id, ...contact_ids, userId || null];

    await query(
      `INSERT INTO contact_group_members (contact_group_id, contact_id, added_at, added_by)
       VALUES ${placeholders}
       ON CONFLICT (contact_id, contact_group_id) DO NOTHING`,
      values
    );

    res.json({
      success: true,
      message: `Added ${contact_ids.length} contact(s) to group`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/contact-groups/:id/contacts/:contactId - Remove contact from group
router.delete('/:id/contacts/:contactId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id, contactId } = req.params;

    // Check if group exists and user has access
    const existingGroup = await queryOne('SELECT * FROM contact_groups WHERE id = $1', [id]);
    if (!existingGroup) {
      return next(createError('Contact group not found', 404));
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId && existingGroup.account_id !== userCompanyId) {
        return next(createError('Access denied', 403));
      }
    }

    await query(
      'DELETE FROM contact_group_members WHERE contact_group_id = $1 AND contact_id = $2',
      [id, contactId]
    );

    res.json({
      success: true,
      message: 'Contact removed from group',
    });
  } catch (error) {
    next(error);
  }
});

export default router;

