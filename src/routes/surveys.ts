import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';

const router = Router();

const createSurveySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  questions: z.array(z.any()),
  is_active: z.boolean().optional(),
});

const submitSurveyResponseSchema = z.object({
  survey_id: z.string().uuid(),
  contact_id: z.string().uuid().optional().nullable(),
  account_id: z.string().uuid().optional().nullable(),
  responses: z.record(z.string(), z.any()),
});

// GET /api/surveys - List all surveys
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { page = '1', limit = '10', is_active } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // Apply company filtering for non-super_admin users
    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId) {
        whereClause += ` AND EXISTS (
          SELECT 1 FROM users u 
          WHERE u.id = s.created_by 
          AND u.account_id = $${paramIndex}
        )`;
        params.push(userCompanyId);
        paramIndex++;
      }
    }

    if (is_active !== undefined) {
      whereClause += ` AND s.is_active = $${paramIndex}`;
      params.push(is_active === 'true');
      paramIndex++;
    }

    const surveys = await query(
      `SELECT s.*, 
        u.first_name || ' ' || u.last_name as created_by_name,
        (SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id) as response_count
       FROM surveys s
       LEFT JOIN users u ON s.created_by = u.id
       ${whereClause} 
       ORDER BY s.created_at DESC 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM surveys s ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: surveys,
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

// GET /api/surveys/:id - Get single survey
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid survey ID format', 400);
    }

    const survey = await queryOne<{
      id: string;
      created_by: string | null;
    }>(
      `SELECT s.*, 
        u.first_name || ' ' || u.last_name as created_by_name
       FROM surveys s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = $1`,
      [id]
    );

    if (!survey) {
      throw createError('Survey not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && survey.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [survey.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Survey access denied', { userId: req.user.userId, surveyId: id, creatorAccountId: creator.account_id, userCompanyId });
        throw createError('Forbidden: You do not have access to this survey', 403);
      }
    }

    res.json({
      success: true,
      data: survey,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/surveys - Create new survey
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = createSurveySchema.parse(req.body);
    const userId = req.user?.userId;
    
    const result = await queryOne(
      `INSERT INTO surveys (name, description, questions, created_by, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        validatedData.name,
        validatedData.description || null,
        JSON.stringify(validatedData.questions),
        userId || null,
        validatedData.is_active !== undefined ? validatedData.is_active : true,
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

// PUT /api/surveys/:id - Update survey
router.put('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid survey ID format', 400);
    }

    const validatedData = createSurveySchema.partial().parse(req.body);

    const existing = await queryOne<{
      id: string;
      created_by: string | null;
    }>('SELECT id, created_by FROM surveys WHERE id = $1', [id]);
    
    if (!existing) {
      throw createError('Survey not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && existing.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [existing.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Survey update access denied', { userId: req.user.userId, surveyId: id });
        throw createError('Forbidden: You do not have access to this survey', 403);
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(validatedData).forEach(([key, value]) => {
      if (key === 'questions') {
        updates.push(`${key} = $${paramIndex}`);
        values.push(JSON.stringify(value));
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
    const result = await queryOne(
      `UPDATE surveys SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex} RETURNING *`,
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

// POST /api/surveys/responses - Submit survey response
router.post('/responses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = submitSurveyResponseSchema.parse(req.body);
    
    // Verify survey exists and is active
    const survey = await queryOne('SELECT id, is_active FROM surveys WHERE id = $1', [validatedData.survey_id]);
    if (!survey) {
      throw createError('Survey not found', 404);
    }
    if (!survey.is_active) {
      throw createError('Survey is not active', 400);
    }

    // TODO: AI sentiment analysis (can be done asynchronously)
    const sentimentScore = null; // Placeholder for AI analysis
    const aiAnalysis = null; // Placeholder for AI analysis

    const result = await queryOne(
      `INSERT INTO survey_responses (survey_id, contact_id, account_id, responses, sentiment_score, ai_analysis)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        validatedData.survey_id,
        validatedData.contact_id || null,
        validatedData.account_id || null,
        JSON.stringify(validatedData.responses),
        sentimentScore,
        aiAnalysis,
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

// DELETE /api/surveys/:id - Delete survey
router.delete('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid survey ID format', 400);
    }

    const existing = await queryOne<{
      id: string;
      created_by: string | null;
    }>('SELECT id, created_by FROM surveys WHERE id = $1', [id]);
    
    if (!existing) {
      throw createError('Survey not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && existing.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [existing.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Survey delete access denied', { userId: req.user.userId, surveyId: id });
        throw createError('Forbidden: You do not have access to this survey', 403);
      }
    }

    await query('DELETE FROM surveys WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'Survey deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/surveys/:id/responses - Get survey responses
router.get('/:id/responses', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { id } = req.params;
    
    // Validate UUID format
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      throw createError('Invalid survey ID format', 400);
    }

    // Verify survey exists and check access
    const survey = await queryOne<{
      id: string;
      created_by: string | null;
    }>('SELECT id, created_by FROM surveys WHERE id = $1', [id]);

    if (!survey) {
      throw createError('Survey not found', 404);
    }

    // Check company access for non-super_admin users
    if (!isSuperAdmin(req.user) && survey.created_by) {
      const creator = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM users WHERE id = $1',
        [survey.created_by]
      );
      
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (creator && creator.account_id !== userCompanyId) {
        logger.warn('Survey responses access denied', { userId: req.user.userId, surveyId: id });
        throw createError('Forbidden: You do not have access to this survey', 403);
      }
    }

    const { page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    // Apply company filtering for responses
    let whereClause = 'WHERE sr.survey_id = $1';
    const params: any[] = [id];
    let paramIndex = 2;

    if (!isSuperAdmin(req.user)) {
      const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
      if (userCompanyId) {
        whereClause += ` AND (sr.account_id = $${paramIndex} OR EXISTS (
          SELECT 1 FROM contacts c 
          WHERE c.id = sr.contact_id 
          AND c.account_id = $${paramIndex}
        ))`;
        params.push(userCompanyId);
        paramIndex++;
      }
    }

    const responses = await query(
      `SELECT sr.*, 
        c.first_name || ' ' || c.last_name as contact_name,
        a.name as account_name
       FROM survey_responses sr
       LEFT JOIN contacts c ON sr.contact_id = c.id
       LEFT JOIN accounts a ON sr.account_id = a.id
       ${whereClause}
       ORDER BY sr.completed_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM survey_responses sr ${whereClause}`,
      params
    );

    const total = parseInt(countResult?.count || '0', 10);

    res.json({
      success: true,
      data: responses,
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

