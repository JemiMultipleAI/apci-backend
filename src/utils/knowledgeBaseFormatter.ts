import { query } from '../db/connection';
import { logger } from './logger';

/**
 * Fetch and format campaign data for knowledge base
 * Returns formatted text with: name, description, instructions, start_date, end_date
 */
export async function getCampaignsKnowledgeBaseText(companyId: string): Promise<string> {
  try {
    const campaigns = await query(
      `SELECT c.id, c.name, c.description, c.instructions, c.start_date, c.end_date
       FROM campaigns c
       INNER JOIN users u ON c.created_by = u.id
       WHERE u.account_id = $1
       AND c.status = 'running'
       AND (c.start_date IS NULL OR c.start_date <= CURRENT_TIMESTAMP)
       AND (c.end_date IS NULL OR c.end_date >= CURRENT_TIMESTAMP)
       ORDER BY c.created_at DESC
       LIMIT 10`,
      [companyId]
    );

    logger.debug('[KNOWLEDGE_BASE] Fetched campaigns', {
      companyId,
      campaignCount: campaigns.length,
    });

    // Format as plain text for knowledge base
    // Include: name, description, instructions, start_date, end_date
    const knowledgeBaseText = campaigns
      .map((campaign: any) => {
        const parts = [`Campaign: ${campaign.name}`];
        if (campaign.description) {
          parts.push(`Description: ${campaign.description}`);
        }
        if (campaign.instructions) {
          parts.push(`Instructions: ${campaign.instructions}`);
        }
        if (campaign.start_date) {
          parts.push(`Start Date: ${new Date(campaign.start_date).toLocaleString()}`);
        }
        if (campaign.end_date) {
          parts.push(`End Date: ${new Date(campaign.end_date).toLocaleString()}`);
        }
        return parts.join('\n');
      })
      .join('\n\n');

    return knowledgeBaseText || 'No active campaigns found.';
  } catch (error: any) {
    logger.error('[KNOWLEDGE_BASE] Failed to fetch campaigns', {
      error: error.message,
      stack: error.stack,
      companyId,
    });
    return 'No active campaigns found.';
  }
}

/**
 * Fetch and format deals data for knowledge base
 * Returns formatted text with deal information
 */
export async function getDealsKnowledgeBaseText(companyId: string): Promise<string> {
  try {
    const deals = await query(
      `SELECT id, name, description, stage, value, probability, 
              expected_close_date, currency
       FROM deals
       WHERE account_id = $1
       AND stage NOT IN ('closed_won', 'closed_lost')
       ORDER BY created_at DESC
       LIMIT 10`,
      [companyId]
    );

    logger.debug('[KNOWLEDGE_BASE] Fetched deals', {
      companyId,
      dealCount: deals.length,
    });

    const knowledgeBaseText = deals
      .map((deal: any) => {
        const parts = [`Deal: ${deal.name}`];
        if (deal.description) {
          parts.push(`Description: ${deal.description}`);
        }
        parts.push(`Stage: ${deal.stage}`);
        parts.push(`Value: ${deal.currency || 'USD'} ${parseFloat(deal.value || '0').toLocaleString()}`);
        parts.push(`Probability: ${deal.probability}%`);
        if (deal.expected_close_date) {
          parts.push(`Expected Close Date: ${new Date(deal.expected_close_date).toLocaleDateString()}`);
        }
        return parts.join('\n');
      })
      .join('\n\n');

    return knowledgeBaseText || 'No open deals found.';
  } catch (error: any) {
    logger.error('[KNOWLEDGE_BASE] Failed to fetch deals', {
      error: error.message,
      stack: error.stack,
      companyId,
    });
    return 'No open deals found.';
  }
}

