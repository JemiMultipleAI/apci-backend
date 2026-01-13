import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { query, queryOne } from '../db/connection';
import { createError, ErrorCodes } from '../middleware/errorHandler';
import { getEffectiveCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';
import { withCache } from '../utils/cache';
import { Conversation } from '../models/mongodb/Conversation';

const router = Router();

// GET /api/campaign-analytics/:campaignId - Get analytics for a specific campaign
router.get('/:campaignId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { campaignId } = req.params;
    const { company_id } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    // Build cache key
    const cacheKey = `campaign-analytics:${campaignId}:${effectiveCompanyId || 'all'}`;

    // Use cache wrapper (2 minute TTL for campaign analytics)
    return res.json(await withCache(
      cacheKey,
      async () => {
        // Get campaign details
        const campaign = await queryOne<{
          id: string;
          name: string;
          channel: string;
          status: string;
          created_by: string | null;
        }>('SELECT id, name, channel, status, created_by FROM campaigns WHERE id = $1', [campaignId]);

        if (!campaign) {
          throw createError('Campaign not found', 404, ErrorCodes.NOT_FOUND);
        }

        // Check company access
        if (effectiveCompanyId && campaign.created_by) {
          const creator = await queryOne<{ account_id: string | null }>(
            'SELECT account_id FROM users WHERE id = $1',
            [campaign.created_by]
          );
          if (creator && creator.account_id !== effectiveCompanyId) {
            throw createError('Forbidden: You do not have access to this campaign', 403, ErrorCodes.FORBIDDEN);
          }
        }

        // Get activities for this campaign
        const activities = await query<{
          type: string;
          status: string;
          created_at: Date;
        }>(
          `SELECT type, status, created_at 
           FROM activities 
           WHERE related_to_type = 'campaign' 
             AND related_to_id = $1
             ${effectiveCompanyId ? 'AND account_id = $2' : ''}
           ORDER BY created_at DESC`,
          effectiveCompanyId ? [campaignId, effectiveCompanyId] : [campaignId]
        );

        // Count by type and status
        const stats = {
          total: activities.length,
          email: activities.filter(a => a.type === 'email').length,
          sms: activities.filter(a => a.type === 'sms').length,
          call: activities.filter(a => a.type === 'call').length,
          sent: activities.filter(a => a.status === 'sent' || a.status === 'delivered').length,
          failed: activities.filter(a => a.status === 'failed' || a.status === 'error').length,
          pending: activities.filter(a => a.status === 'pending' || a.status === 'queued').length,
        };

        // Get conversations from MongoDB for response tracking
        const conversations = await Conversation.find({
          campaign_id: campaignId,
          ...(effectiveCompanyId && { account_id: effectiveCompanyId }),
        }).lean();

        const responseStats = {
          totalResponses: conversations.reduce((sum, conv) => sum + (conv.messages?.filter(m => m.role === 'user').length || 0), 0),
          emailResponses: conversations.filter(c => c.channel === 'email').length,
          smsResponses: conversations.filter(c => c.channel === 'sms').length,
          callResponses: conversations.filter(c => c.channel === 'call').length,
        };

        // Calculate response rates
        const responseRates = {
          email: stats.email > 0 ? (responseStats.emailResponses / stats.email) * 100 : 0,
          sms: stats.sms > 0 ? (responseStats.smsResponses / stats.sms) * 100 : 0,
          call: stats.call > 0 ? (responseStats.callResponses / stats.call) * 100 : 0,
          overall: stats.total > 0 ? (responseStats.totalResponses / stats.total) * 100 : 0,
        };

        return {
          success: true,
          data: {
            campaign: {
              id: campaign.id,
              name: campaign.name,
              channel: campaign.channel,
              status: campaign.status,
            },
            stats,
            responseStats,
            responseRates,
            activities: activities.slice(0, 50), // Last 50 activities
          },
        };
      },
      120 // 2 minute cache
    ));
  } catch (error: any) {
    logger.error('[CAMPAIGN_ANALYTICS] Error:', {
      error: error.message,
      campaignId: req.params.campaignId,
      requestId: req.requestId,
    });
    next(error);
  }
});

export default router;
