import { env } from '../config/env';
import { query, queryOne } from '../db/connection';

/**
 * AI Service for insights and predictions
 */

/**
 * Analyze sentiment from text (placeholder - integrate with OpenAI/Anthropic)
 */
export const analyzeSentiment = async (text: string): Promise<{
  sentiment: 'positive' | 'neutral' | 'negative';
  score: number;
}> => {
  // TODO: Integrate with OpenAI or Anthropic API
  // For now, return placeholder
  if (!env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY) {
    return { sentiment: 'neutral', score: 0.5 };
  }

  // Placeholder implementation
  const positiveWords = ['good', 'great', 'excellent', 'happy', 'satisfied', 'love'];
  const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'disappointed', 'frustrated'];
  
  const lowerText = text.toLowerCase();
  const positiveCount = positiveWords.filter(word => lowerText.includes(word)).length;
  const negativeCount = negativeWords.filter(word => lowerText.includes(word)).length;

  if (positiveCount > negativeCount) {
    return { sentiment: 'positive', score: 0.7 };
  } else if (negativeCount > positiveCount) {
    return { sentiment: 'negative', score: 0.3 };
  }
  
  return { sentiment: 'neutral', score: 0.5 };
};

/**
 * Predict churn probability for a contact
 */
export const predictChurn = async (contactId: string): Promise<{
  probability: number;
  factors: string[];
}> => {
  const contact = await queryOne<{
    lifecycle_stage: string;
    days_since_activity: number;
    activity_count: string;
  }>(
    `SELECT 
      c.lifecycle_stage,
      CASE 
        WHEN MAX(a.created_at) IS NULL THEN 999
        ELSE EXTRACT(DAY FROM (CURRENT_TIMESTAMP - MAX(a.created_at)))::INTEGER
      END as days_since_activity,
      COUNT(a.id) as activity_count
    FROM contacts c
    LEFT JOIN activities a ON (
      a.related_to_type = 'contact' AND a.related_to_id = c.id
    )
    WHERE c.id = $1
    GROUP BY c.id, c.lifecycle_stage`,
    [contactId]
  );

  if (!contact) {
    return { probability: 0, factors: [] };
  }

  let probability = 0;
  const factors: string[] = [];

  // Days since last activity
  const daysInactive = contact.days_since_activity || 0;
  if (daysInactive > 90) {
    probability += 40;
    factors.push('No activity in 90+ days');
  } else if (daysInactive > 60) {
    probability += 25;
    factors.push('No activity in 60+ days');
  } else if (daysInactive > 30) {
    probability += 15;
    factors.push('No activity in 30+ days');
  }

  // Low activity count
  const activityCount = parseInt(contact.activity_count || '0', 10);
  if (activityCount < 3) {
    probability += 20;
    factors.push('Low engagement history');
  }

  // Lifecycle stage
  if (contact.lifecycle_stage === 'churned') {
    probability = 100;
    factors.push('Already churned');
  }

  return {
    probability: Math.min(probability, 100),
    factors,
  };
};

/**
 * Get next best action recommendation for a contact
 */
export const getNextBestAction = async (contactId: string): Promise<{
  action: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}> => {
  const contact = await queryOne<{
    lifecycle_stage: string;
    days_since_activity: number;
    has_open_deals: boolean;
    last_activity_type: string | null;
  }>(
    `SELECT 
      c.lifecycle_stage,
      CASE 
        WHEN MAX(a.created_at) IS NULL THEN 999
        ELSE EXTRACT(DAY FROM (CURRENT_TIMESTAMP - MAX(a.created_at)))::INTEGER
      END as days_since_activity,
      EXISTS(SELECT 1 FROM deals WHERE contact_id = c.id AND stage NOT IN ('closed_won', 'closed_lost')) as has_open_deals,
      (SELECT type FROM activities WHERE related_to_type = 'contact' AND related_to_id = c.id ORDER BY created_at DESC LIMIT 1) as last_activity_type
    FROM contacts c
    LEFT JOIN activities a ON (
      a.related_to_type = 'contact' AND a.related_to_id = c.id
    )
    WHERE c.id = $1
    GROUP BY c.id, c.lifecycle_stage`,
    [contactId]
  );

  if (!contact) {
    return {
      action: 'No recommendation',
      reason: 'Contact not found',
      priority: 'low',
    };
  }

  const daysInactive = contact.days_since_activity || 0;

  // High priority: Dormant customer with open deals
  if (contact.has_open_deals && daysInactive > 60) {
    return {
      action: 'Schedule follow-up call',
      reason: 'Open deal with no recent activity',
      priority: 'high',
    };
  }

  // High priority: Dormant customer
  if (contact.lifecycle_stage === 'customer' && daysInactive > 90) {
    return {
      action: 'Send subscription reactivation email',
      reason: 'Customer inactive for 90+ days',
      priority: 'high',
    };
  }

  // Medium priority: Qualified lead with no activity
  if (contact.lifecycle_stage === 'qualified' && daysInactive > 30) {
    return {
      action: 'Send nurturing email',
      reason: 'Qualified lead needs engagement',
      priority: 'medium',
    };
  }

  // Low priority: Recent activity
  if (daysInactive < 7) {
    return {
      action: 'Continue current engagement',
      reason: 'Recent activity detected',
      priority: 'low',
    };
  }

  return {
    action: 'Send check-in message',
    reason: 'Maintain regular contact',
    priority: 'medium',
  };
};

