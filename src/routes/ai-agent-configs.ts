import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { z, ZodError } from 'zod';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { applyCompanyFilter } from '../middleware/companyFilter';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { env } from '../config/env';
import { updateMultipleKnowledgeBaseDocuments } from '../services/elevenlabsKnowledgeBase';

const router = Router();

const createAgentConfigSchema = z.object({
  account_id: z.string().uuid().optional().nullable(),
  agent_id: z.string().min(1), // ElevenLabs agent ID (internal)
  name: z.string().min(1), // Friendly name for companies
  description: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
  kb_campaigns_document_id: z.string().optional().nullable(), // ElevenLabs knowledge base document ID for campaigns
  kb_deals_document_id: z.string().optional().nullable(), // ElevenLabs knowledge base document ID for deals
});

const updateAgentConfigSchema = z.object({
  agent_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
  kb_campaigns_document_id: z.string().optional().nullable(),
  kb_deals_document_id: z.string().optional().nullable(),
});

// Generate knowledge base token for a company
function generateKnowledgeBaseToken(companyId: string): string {
  const secret = env.KNOWLEDGE_BASE_SECRET || 'default-secret-change-me-in-production';
  return crypto
    .createHmac('sha256', secret)
    .update(companyId)
    .digest('hex');
}

// GET /api/ai-agent-configs - List agent configurations (super_admin only)
router.get('/', authenticate, enrichUser, applyCompanyFilter('aac'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Only super_admin can access
    if (!isSuperAdmin(req.user)) {
      return next(createError('Forbidden: Only super_admin can access agent configurations', 403));
    }

    const { page = '1', limit = '20', account_id, is_active } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    let whereClause = 'WHERE 1=1';
    const params: (string | number | boolean)[] = [];
    let paramIndex = 1;

    // Apply company filter (super_admin can see all or filter)
    if (req.companyFilter && req.companyFilter.value !== null) {
      whereClause += ` ${req.companyFilter.clause.replace('account_id', 'aac.account_id')}`;
      params.push(req.companyFilter.value);
      paramIndex = req.companyFilter.paramIndex + 1;
    }

    if (account_id) {
      const accountIdStr = Array.isArray(account_id) ? account_id[0] : account_id;
      if (typeof accountIdStr === 'string') {
        const uuidSchema = z.string().uuid();
        if (uuidSchema.safeParse(accountIdStr).success) {
          whereClause += ` AND aac.account_id = $${paramIndex}`;
          params.push(accountIdStr);
          paramIndex++;
        }
      }
    }

    if (is_active !== undefined) {
      const isActiveValue = Array.isArray(is_active) ? is_active[0] : is_active;
      let isActive: boolean;
      if (typeof isActiveValue === 'boolean') {
        isActive = isActiveValue;
      } else if (typeof isActiveValue === 'string') {
        isActive = isActiveValue === 'true' || isActiveValue === '1';
      } else {
        isActive = false;
      }
      whereClause += ` AND aac.is_active = $${paramIndex}`;
      params.push(isActive);
      paramIndex++;
    }

    const configs = await query(
      `SELECT 
        aac.id,
        aac.account_id,
        aac.name,
        aac.description,
        aac.is_active,
        aac.kb_campaigns_document_id,
        aac.kb_deals_document_id,
        aac.created_at,
        aac.updated_at,
        a.name as account_name
       FROM ai_agent_configurations aac
       LEFT JOIN accounts a ON aac.account_id = a.id
       ${whereClause}
       ORDER BY aac.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit as string), offset]
    );

    // Remove agent_id from response (internal only)
    const sanitizedConfigs = configs.map((config: any) => {
      const { agent_id, ...rest } = config;
      return rest;
    });

    const countResult = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM ai_agent_configurations aac ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: sanitizedConfigs,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: parseInt(countResult?.count || '0'),
      },
    });
  } catch (error: any) {
    next(error);
  }
});

// GET /api/ai-agent-configs/:id - Get agent configuration (super_admin only)
router.get('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Only super_admin can access
    if (!isSuperAdmin(req.user)) {
      return next(createError('Forbidden: Only super_admin can access agent configurations', 403));
    }

    const { id } = req.params;
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      return next(createError('Invalid agent configuration ID format', 400));
    }

    const config = await queryOne(
      `SELECT 
        aac.*,
        a.name as account_name
       FROM ai_agent_configurations aac
       LEFT JOIN accounts a ON aac.account_id = a.id
       WHERE aac.id = $1`,
      [id]
    );

    if (!config) {
      return next(createError('Agent configuration not found', 404));
    }

    // Generate knowledge base URLs if company exists
    let knowledgeBaseUrls = null;
    if (config.account_id) {
      const token = generateKnowledgeBaseToken(config.account_id);
      const baseUrl = env.PUBLIC_WEBHOOK_URL || env.API_BASE_URL || 'http://localhost:3001';
      
      knowledgeBaseUrls = {
        campaigns: `${baseUrl}/api/knowledge-base/${token}/company/${config.account_id}/campaigns`,
        deals: `${baseUrl}/api/knowledge-base/${token}/company/${config.account_id}/deals`,
      };
    }

    // Include agent_id for super_admin (they need it for management)
    res.json({
      success: true,
      data: {
        ...config,
        knowledge_base_urls: knowledgeBaseUrls,
      },
    });
  } catch (error: any) {
    next(error);
  }
});

// POST /api/ai-agent-configs - Create agent configuration (super_admin only)
router.post('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Only super_admin can create
    if (!isSuperAdmin(req.user)) {
      return next(createError('Forbidden: Only super_admin can create agent configurations', 403));
    }

    const validatedData = createAgentConfigSchema.parse(req.body);

    // Validate account_id exists if provided
    if (validatedData.account_id) {
      const account = await queryOne('SELECT id FROM accounts WHERE id = $1', [validatedData.account_id]);
      if (!account) {
        return next(createError('Account not found', 404));
      }
    }

    const result = await queryOne(
      `INSERT INTO ai_agent_configurations (
        account_id, agent_id, name, description, is_active, created_by,
        kb_campaigns_document_id, kb_deals_document_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, account_id, name, description, is_active, kb_campaigns_document_id, kb_deals_document_id, created_at, updated_at`,
      [
        validatedData.account_id || null,
        validatedData.agent_id,
        validatedData.name,
        validatedData.description || null,
        validatedData.is_active !== undefined ? validatedData.is_active : true,
        req.user.userId,
        validatedData.kb_campaigns_document_id || null,
        validatedData.kb_deals_document_id || null,
      ]
    );

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map(e => e.message).join(', '), 400));
    }
    if (error.code === '23505') { // Unique constraint violation
      return next(createError('Agent configuration already exists for this company', 409));
    }
    next(error);
  }
});

// PUT /api/ai-agent-configs/:id - Update agent configuration (super_admin only)
router.put('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Only super_admin can update
    if (!isSuperAdmin(req.user)) {
      return next(createError('Forbidden: Only super_admin can update agent configurations', 403));
    }

    const { id } = req.params;
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      return next(createError('Invalid agent configuration ID format', 400));
    }

    const validatedData = updateAgentConfigSchema.parse(req.body);

    const existing = await queryOne('SELECT id FROM ai_agent_configurations WHERE id = $1', [id]);
    if (!existing) {
      return next(createError('Agent configuration not found', 404));
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(validatedData).forEach(([key, value]) => {
      if (value !== undefined) {
        updates.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });

    if (updates.length === 0) {
      return next(createError('No fields to update', 400));
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    const result = await queryOne(
      `UPDATE ai_agent_configurations 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, account_id, name, description, is_active, kb_campaigns_document_id, kb_deals_document_id, created_at, updated_at`,
      [...values, id]
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map(e => e.message).join(', '), 400));
    }
    next(error);
  }
});

// DELETE /api/ai-agent-configs/:id - Delete agent configuration (super_admin only)
router.delete('/:id', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Only super_admin can delete
    if (!isSuperAdmin(req.user)) {
      return next(createError('Forbidden: Only super_admin can delete agent configurations', 403));
    }

    const { id } = req.params;
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      return next(createError('Invalid agent configuration ID format', 400));
    }

    const existing = await queryOne('SELECT id FROM ai_agent_configurations WHERE id = $1', [id]);
    if (!existing) {
      return next(createError('Agent configuration not found', 404));
    }

    await query('DELETE FROM ai_agent_configurations WHERE id = $1', [id]);

    res.json({
      success: true,
      message: 'Agent configuration deleted successfully',
    });
  } catch (error: any) {
    next(error);
  }
});

// POST /api/ai-agent-configs/:id/refresh-knowledge-base - Refresh knowledge base documents (super_admin only)
router.post('/:id/refresh-knowledge-base', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Only super_admin can refresh
    if (!isSuperAdmin(req.user)) {
      return next(createError('Forbidden: Only super_admin can refresh knowledge base', 403));
    }

    const { id } = req.params;
    const uuidSchema = z.string().uuid();
    if (!uuidSchema.safeParse(id).success) {
      return next(createError('Invalid agent configuration ID format', 400));
    }

    const config = await queryOne<{
      id: string;
      account_id: string | null;
      name: string;
      kb_campaigns_document_id: string | null;
      kb_deals_document_id: string | null;
    }>(
      `SELECT id, account_id, name, kb_campaigns_document_id, kb_deals_document_id
       FROM ai_agent_configurations
       WHERE id = $1`,
      [id]
    );

    if (!config) {
      return next(createError('Agent configuration not found', 404));
    }

    if (!config.account_id) {
      return res.json({
        success: false,
        message: 'Agent configuration must be associated with a company to refresh knowledge base.',
        results: {
          success: [],
          failed: [],
        },
      });
    }

    // Build list of documents to update
    const documentsToUpdate: Array<{ 
      documentationId: string; 
      companyId: string;
      type: 'campaigns' | 'deals';
      displayName: string;
    }> = [];

    if (config.kb_campaigns_document_id) {
      documentsToUpdate.push({
        documentationId: config.kb_campaigns_document_id,
        companyId: config.account_id,
        type: 'campaigns',
        displayName: `${config.name} - Campaigns Knowledge Base`,
      });
    }

    if (config.kb_deals_document_id) {
      documentsToUpdate.push({
        documentationId: config.kb_deals_document_id,
        companyId: config.account_id,
        type: 'deals',
        displayName: `${config.name} - Deals Knowledge Base`,
      });
    }

    if (documentsToUpdate.length === 0) {
      return res.json({
        success: true,
        message: 'No knowledge base documents configured. Please add document IDs to the agent configuration.',
        results: {
          success: [],
          failed: [],
        },
      });
    }

    // Update all documents
    const results = await updateMultipleKnowledgeBaseDocuments(documentsToUpdate);

    logger.info('[AI_AGENT_CONFIG] Knowledge base refreshed', {
      configId: id,
      successCount: results.success.length,
      failedCount: results.failed.length,
    });

    res.json({
      success: true,
      message: `Refreshed ${results.success.length} document(s)${results.failed.length > 0 ? `, ${results.failed.length} failed` : ''}`,
      results,
    });
  } catch (error: any) {
    logger.error('[AI_AGENT_CONFIG] Error refreshing knowledge base', {
      configId: req.params.id,
      error: error.message,
    });
    next(error);
  }
});

export default router;

