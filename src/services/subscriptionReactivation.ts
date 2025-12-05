import { query, queryOne } from '../db/connection';

/**
 * Subscription Reactivation Service
 * Identifies dormant contacts and manages subscription reactivation campaigns
 */

export interface DormantContact {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  account_id: string | null;
  last_activity_date: Date | null;
  days_since_activity: number;
  reactivation_score: number;
}

/**
 * Find dormant contacts (no activity in last N days)
 */
export const findDormantContacts = async (daysInactive: number = 90): Promise<DormantContact[]> => {
  const result = await query<DormantContact>(
    `SELECT 
      c.id,
      c.first_name,
      c.last_name,
      c.email,
      c.phone,
      c.account_id,
      MAX(a.created_at) as last_activity_date,
      EXTRACT(DAY FROM (CURRENT_TIMESTAMP - MAX(a.created_at)))::INTEGER as days_since_activity,
      CASE 
        WHEN MAX(a.created_at) IS NULL THEN 100
        ELSE EXTRACT(DAY FROM (CURRENT_TIMESTAMP - MAX(a.created_at)))::INTEGER
      END as reactivation_score
    FROM contacts c
    LEFT JOIN activities a ON (
      (a.related_to_type = 'contact' AND a.related_to_id = c.id)
    )
    WHERE c.lifecycle_stage != 'churned'
    GROUP BY c.id, c.first_name, c.last_name, c.email, c.phone, c.account_id
    HAVING MAX(a.created_at) IS NULL 
       OR EXTRACT(DAY FROM (CURRENT_TIMESTAMP - MAX(a.created_at)))::INTEGER >= $1
    ORDER BY reactivation_score DESC
    LIMIT 100`,
    [daysInactive]
  );

  return result;
};

/**
 * Calculate subscription reactivation score for a contact
 */
export const calculateSubscriptionReactivationScore = async (contactId: string): Promise<number> => {
  const contact = await queryOne<{
    lifecycle_stage: string;
    last_activity: Date | null;
    days_since_activity: number;
  }>(
    `SELECT 
      c.lifecycle_stage,
      MAX(a.created_at) as last_activity,
      CASE 
        WHEN MAX(a.created_at) IS NULL THEN 999
        ELSE EXTRACT(DAY FROM (CURRENT_TIMESTAMP - MAX(a.created_at)))::INTEGER
      END as days_since_activity
    FROM contacts c
    LEFT JOIN activities a ON (
      (a.related_to_type = 'contact' AND a.related_to_id = c.id)
    )
    WHERE c.id = $1
    GROUP BY c.id, c.lifecycle_stage`,
    [contactId]
  );

  if (!contact) return 0;

  // Higher score = more dormant
  let score = contact.days_since_activity || 0;

  // Adjust based on lifecycle stage
  if (contact.lifecycle_stage === 'customer') {
    score *= 1.5; // Prioritize reactivating customers
  } else if (contact.lifecycle_stage === 'qualified') {
    score *= 1.2;
  }

  return Math.min(score, 100); // Cap at 100
};

/**
 * Get subscription reactivation campaign statistics
 */
export const getSubscriptionReactivationStats = async (campaignId: string) => {
  const stats = await queryOne<{
    total_contacts: string;
    contacted: string;
    responded: string;
    reactivated: string;
  }>(
    `SELECT 
      COUNT(DISTINCT c.id) as total_contacts,
      COUNT(DISTINCT CASE WHEN a.type IN ('email', 'sms', 'call') THEN a.id END) as contacted,
      COUNT(DISTINCT CASE WHEN a.type IN ('email', 'sms', 'call') AND a.metadata->>'responded' = 'true' THEN a.id END) as responded,
      COUNT(DISTINCT CASE WHEN c.lifecycle_stage = 'customer' THEN c.id END) as reactivated
    FROM contacts c
    LEFT JOIN activities a ON (
      a.related_to_type = 'contact' 
      AND a.related_to_id = c.id
      AND a.metadata->>'campaign_id' = $1
    )
    WHERE c.id IN (
      SELECT DISTINCT related_to_id 
      FROM activities 
      WHERE related_to_type = 'contact' 
      AND metadata->>'campaign_id' = $1
    )`,
    [campaignId]
  );

  return {
    totalContacts: parseInt(stats?.total_contacts || '0', 10),
    contacted: parseInt(stats?.contacted || '0', 10),
    responded: parseInt(stats?.responded || '0', 10),
    reactivated: parseInt(stats?.reactivated || '0', 10),
  };
};

