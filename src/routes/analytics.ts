import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { getEffectiveCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';
import { withCache } from '../utils/cache';

const router = Router();

// GET /api/analytics/dashboard - Get dashboard analytics
router.get('/dashboard', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { company_id } = req.query;
    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    logger.info('[ANALYTICS] Dashboard endpoint called', {
      userId: req.user.userId,
      effectiveCompanyId: effectiveCompanyId || 'all (super_admin)',
      requestId: req.requestId,
    });

    // Build cache key
    const cacheKey = `analytics:dashboard:${effectiveCompanyId || 'all'}`;

    // Use cache wrapper (5 minute TTL)
    return res.json(await withCache(
      cacheKey,
      async () => {
        // Build company filter clause
        const companyFilter = effectiveCompanyId
          ? 'AND account_id = $1'
          : '';
        const params = effectiveCompanyId ? [effectiveCompanyId] : [];

    // Get key metrics with company filtering
    const [
      totalContacts,
      totalAccounts,
      totalDeals,
      activeDeals,
      totalRevenue,
      pipelineValue,
    ] = await Promise.all([
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM contacts WHERE 1=1 ${companyFilter}`,
        params
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM accounts WHERE 1=1 ${companyFilter}`,
        params
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM deals d 
         INNER JOIN accounts a ON d.account_id = a.id 
         WHERE 1=1 ${companyFilter}`,
        params
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM deals d 
         INNER JOIN accounts a ON d.account_id = a.id 
         WHERE d.stage NOT IN ('closed_won', 'closed_lost') ${companyFilter}`,
        params
      ),
      queryOne<{ sum: string }>(
        `SELECT COALESCE(SUM(d.value), 0) as sum 
         FROM deals d 
         INNER JOIN accounts a ON d.account_id = a.id 
         WHERE d.stage = 'closed_won' ${companyFilter}`,
        params
      ),
      queryOne<{ sum: string }>(
        `SELECT COALESCE(SUM(d.value * d.probability / 100.0), 0) as sum 
         FROM deals d 
         INNER JOIN accounts a ON d.account_id = a.id 
         WHERE d.stage NOT IN ('closed_won', 'closed_lost') ${companyFilter}`,
        params
      ),
    ]);

    // Get recent activities with company filtering
    const recentActivities = await query(
      `SELECT a.*, 
        u.first_name || ' ' || u.last_name as performed_by_name
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE 1=1 ${companyFilter}
       ORDER BY a.created_at DESC
       LIMIT 10`,
      params
    );

    // Get pipeline by stage with company filtering
    const pipelineByStage = await query(
      `SELECT 
        d.stage,
        COUNT(*) as count,
        COALESCE(SUM(d.value), 0) as total_value
       FROM deals d
       INNER JOIN accounts a ON d.account_id = a.id
       WHERE d.stage NOT IN ('closed_won', 'closed_lost') ${companyFilter}
       GROUP BY d.stage
       ORDER BY 
         CASE d.stage
           WHEN 'lead' THEN 1
           WHEN 'qualified' THEN 2
           WHEN 'proposal' THEN 3
           WHEN 'negotiation' THEN 4
         END`,
      params
    );

        return {
          success: true,
          data: {
            metrics: {
              totalContacts: parseInt(totalContacts?.count || '0', 10),
              totalAccounts: parseInt(totalAccounts?.count || '0', 10),
              totalDeals: parseInt(totalDeals?.count || '0', 10),
              activeDeals: parseInt(activeDeals?.count || '0', 10),
              totalRevenue: parseFloat(totalRevenue?.sum || '0'),
              pipelineValue: parseFloat(pipelineValue?.sum || '0'),
            },
            pipelineByStage,
            recentActivities,
          },
        };
      },
      300 // 5 minute cache
    ));
  } catch (error: any) {
    logger.error('[ANALYTICS] Dashboard error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// GET /api/analytics/revenue - Get revenue analytics
router.get('/revenue', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { period = '30', company_id } = req.query;
    const days = parseInt(period as string);
    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    // Build cache key
    const cacheKey = `analytics:revenue:${effectiveCompanyId || 'all'}:${days}`;

    // Use cache wrapper (10 minute TTL for revenue data)
    return res.json(await withCache(
      cacheKey,
      async () => {
        // Build company filter clause
        const companyFilter = effectiveCompanyId
          ? 'AND a.account_id = $1'
          : '';
        const params = effectiveCompanyId ? [effectiveCompanyId] : [];

        // Revenue over time with company filtering
        const revenueOverTime = await query(
          `SELECT 
            DATE(d.actual_close_date) as date,
            COUNT(*) as deal_count,
            COALESCE(SUM(d.value), 0) as revenue
           FROM deals d
           INNER JOIN accounts a ON d.account_id = a.id
           WHERE d.stage = 'closed_won'
             AND d.actual_close_date >= CURRENT_DATE - INTERVAL '${days} days'
             ${companyFilter}
           GROUP BY DATE(d.actual_close_date)
           ORDER BY date ASC`,
          params
        );

        // Revenue by stage with company filtering
        const revenueByStage = await query(
          `SELECT 
            d.stage,
            COUNT(*) as count,
            COALESCE(SUM(d.value), 0) as total_value,
            COALESCE(AVG(d.value), 0) as avg_value
           FROM deals d
           INNER JOIN accounts a ON d.account_id = a.id
           WHERE 1=1 ${companyFilter}
           GROUP BY d.stage
           ORDER BY 
             CASE d.stage
               WHEN 'lead' THEN 1
               WHEN 'qualified' THEN 2
               WHEN 'proposal' THEN 3
               WHEN 'negotiation' THEN 4
               WHEN 'closed_won' THEN 5
               WHEN 'closed_lost' THEN 6
             END`,
          params
        );

        return {
          success: true,
          data: {
            revenueOverTime,
            revenueByStage,
          },
        };
      },
      600 // 10 minute cache
    ));
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/contacts - Get contact analytics
router.get('/contacts', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    const { company_id } = req.query;
    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    // Build cache key
    const cacheKey = `analytics:contacts:${effectiveCompanyId || 'all'}`;

    // Use cache wrapper (5 minute TTL)
    return res.json(await withCache(
      cacheKey,
      async () => {
        // Build company filter clause
        const companyFilter = effectiveCompanyId
          ? 'AND account_id = $1'
          : '';
        const params = effectiveCompanyId ? [effectiveCompanyId] : [];

        // Contacts by lifecycle stage with company filtering
        const byLifecycle = await query(
          `SELECT 
            lifecycle_stage,
            COUNT(*) as count
           FROM contacts
           WHERE 1=1 ${companyFilter}
           GROUP BY lifecycle_stage
           ORDER BY 
             CASE lifecycle_stage
               WHEN 'lead' THEN 1
               WHEN 'qualified' THEN 2
               WHEN 'customer' THEN 3
               WHEN 'churned' THEN 4
             END`,
          params
        );

        // Activity by type with company filtering
        const activityByType = await query(
          `SELECT 
            type,
            COUNT(*) as count
           FROM activities
           WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
             ${companyFilter}
           GROUP BY type
           ORDER BY count DESC`,
          params
        );

        return {
          success: true,
          data: {
            byLifecycle,
            activityByType,
          },
        };
      },
      300 // 5 minute cache
    ));
  } catch (error) {
    next(error);
  }
});

export default router;

