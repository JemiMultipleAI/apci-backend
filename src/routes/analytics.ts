import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';

const router = Router();

// GET /api/analytics/dashboard - Get dashboard analytics
router.get('/dashboard', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    console.log('🔵 [ANALYTICS] Dashboard endpoint called');
    console.log('🔵 [ANALYTICS] Authenticated user:', req.user?.userId);
    // Get key metrics
    const [
      totalContacts,
      totalAccounts,
      totalDeals,
      activeDeals,
      totalRevenue,
      pipelineValue,
    ] = await Promise.all([
      queryOne<{ count: string }>('SELECT COUNT(*) as count FROM contacts'),
      queryOne<{ count: string }>('SELECT COUNT(*) as count FROM accounts'),
      queryOne<{ count: string }>('SELECT COUNT(*) as count FROM deals'),
      queryOne<{ count: string }>(
        "SELECT COUNT(*) as count FROM deals WHERE stage NOT IN ('closed_won', 'closed_lost')"
      ),
      queryOne<{ sum: string }>(
        "SELECT COALESCE(SUM(value), 0) as sum FROM deals WHERE stage = 'closed_won'"
      ),
      queryOne<{ sum: string }>(
        "SELECT COALESCE(SUM(value * probability / 100.0), 0) as sum FROM deals WHERE stage NOT IN ('closed_won', 'closed_lost')"
      ),
    ]);

    // Get recent activities
    const recentActivities = await query(
      `SELECT a.*, 
        u.first_name || ' ' || u.last_name as performed_by_name
       FROM activities a
       LEFT JOIN users u ON a.performed_by = u.id
       ORDER BY a.created_at DESC
       LIMIT 10`
    );

    // Get pipeline by stage
    const pipelineByStage = await query(
      `SELECT 
        stage,
        COUNT(*) as count,
        COALESCE(SUM(value), 0) as total_value
       FROM deals
       WHERE stage NOT IN ('closed_won', 'closed_lost')
       GROUP BY stage
       ORDER BY 
         CASE stage
           WHEN 'lead' THEN 1
           WHEN 'qualified' THEN 2
           WHEN 'proposal' THEN 3
           WHEN 'negotiation' THEN 4
         END`
    );

    res.json({
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
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/revenue - Get revenue analytics
router.get('/revenue', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { period = '30' } = req.query;
    const days = parseInt(period as string);

    // Revenue over time
    const revenueOverTime = await query(
      `SELECT 
        DATE(actual_close_date) as date,
        COUNT(*) as deal_count,
        COALESCE(SUM(value), 0) as revenue
       FROM deals
       WHERE stage = 'closed_won'
         AND actual_close_date >= CURRENT_DATE - INTERVAL '${days} days'
       GROUP BY DATE(actual_close_date)
       ORDER BY date ASC`
    );

    // Revenue by stage
    const revenueByStage = await query(
      `SELECT 
        stage,
        COUNT(*) as count,
        COALESCE(SUM(value), 0) as total_value,
        COALESCE(AVG(value), 0) as avg_value
       FROM deals
       GROUP BY stage
       ORDER BY 
         CASE stage
           WHEN 'lead' THEN 1
           WHEN 'qualified' THEN 2
           WHEN 'proposal' THEN 3
           WHEN 'negotiation' THEN 4
           WHEN 'closed_won' THEN 5
           WHEN 'closed_lost' THEN 6
         END`
    );

    res.json({
      success: true,
      data: {
        revenueOverTime,
        revenueByStage,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/contacts - Get contact analytics
router.get('/contacts', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Contacts by lifecycle stage
    const byLifecycle = await query(
      `SELECT 
        lifecycle_stage,
        COUNT(*) as count
       FROM contacts
       GROUP BY lifecycle_stage
       ORDER BY 
         CASE lifecycle_stage
           WHEN 'lead' THEN 1
           WHEN 'qualified' THEN 2
           WHEN 'customer' THEN 3
           WHEN 'churned' THEN 4
         END`
    );

    // Activity by type
    const activityByType = await query(
      `SELECT 
        type,
        COUNT(*) as count
       FROM activities
       WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY type
       ORDER BY count DESC`
    );

    res.json({
      success: true,
      data: {
        byLifecycle,
        activityByType,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

