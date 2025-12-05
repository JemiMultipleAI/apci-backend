import { query } from '../db/connection';

/**
 * Fetch and format campaign data for knowledge base
 * Returns formatted text with: name, description, start_date, end_date
 */
export async function getCampaignsKnowledgeBaseText(companyId: string): Promise<string> {
  const campaigns = await query(
    `SELECT c.id, c.name, c.description, c.start_date, c.end_date
     FROM campaigns c
     WHERE EXISTS (
       SELECT 1 FROM users u 
       WHERE u.id = c.created_by 
       AND u.account_id = $1
     )
     AND c.status = 'running'
     AND (c.start_date IS NULL OR c.start_date <= CURRENT_TIMESTAMP)
     AND (c.end_date IS NULL OR c.end_date >= CURRENT_TIMESTAMP)
     ORDER BY c.created_at DESC`,
    [companyId]
  );

  // Format as plain text for ElevenLabs knowledge base
  // Only include: name, description, start_date, end_date
  const knowledgeBaseText = campaigns
    .map((campaign: any) => {
      const parts = [`Name: ${campaign.name}`];
      if (campaign.description) {
        parts.push(`Description: ${campaign.description}`);
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
}

/**
 * Fetch and format deals data for knowledge base
 * Returns formatted text with deal information
 */
export async function getDealsKnowledgeBaseText(companyId: string): Promise<string> {
  const deals = await query(
    `SELECT id, name, description, stage, value, probability, 
            expected_close_date, currency
     FROM deals
     WHERE account_id = $1
     AND stage NOT IN ('closed_won', 'closed_lost')
     ORDER BY created_at DESC`,
    [companyId]
  );

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
}

