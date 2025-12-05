import { query, queryOne } from '../db/connection';
import { logger } from '../utils/logger';
import crypto from 'crypto';

export interface WebhookTokenData {
  account_id: string;
  campaign_id?: string | null;
  contact_id?: string | null;
  activity_id?: string | null;
  type: 'email' | 'sms' | 'both';
  expires_at?: Date | null;
  created_by?: string | null;
}

export interface WebhookToken {
  id: string;
  token: string;
  account_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  activity_id: string | null;
  type: 'email' | 'sms' | 'both';
  is_active: boolean;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * Generate a unique webhook token
 */
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new webhook token
 */
export async function createWebhookToken(data: WebhookTokenData): Promise<WebhookToken> {
  let token: string;
  let attempts = 0;
  const maxAttempts = 5;

  // Generate unique token (retry if collision)
  do {
    token = generateToken();
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM webhook_tokens WHERE token = $1',
      [token]
    );
    if (!existing) break;
    attempts++;
  } while (attempts < maxAttempts);

  if (attempts >= maxAttempts) {
    throw new Error('Failed to generate unique webhook token');
  }

  const result = await queryOne<WebhookToken>(
    `INSERT INTO webhook_tokens (
      token, account_id, campaign_id, contact_id, activity_id, type, expires_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      token,
      data.account_id,
      data.campaign_id || null,
      data.contact_id || null,
      data.activity_id || null,
      data.type,
      data.expires_at || null,
      data.created_by || null,
    ]
  );

  if (!result) {
    throw new Error('Failed to create webhook token');
  }

  logger.debug('Webhook token created', { tokenId: result.id, accountId: data.account_id });
  return result;
}

/**
 * Validate and lookup webhook token
 */
export async function validateWebhookToken(token: string): Promise<WebhookToken | null> {
  const result = await queryOne<WebhookToken>(
    `SELECT * FROM webhook_tokens 
     WHERE token = $1 
     AND is_active = true 
     AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
    [token]
  );

  return result || null;
}

/**
 * Get webhook token by ID
 */
export async function getWebhookTokenById(id: string): Promise<WebhookToken | null> {
  const result = await queryOne<WebhookToken>(
    'SELECT * FROM webhook_tokens WHERE id = $1',
    [id]
  );

  return result || null;
}

/**
 * Deactivate a webhook token
 */
export async function deactivateWebhookToken(token: string): Promise<boolean> {
  const result = await queryOne<{ id: string }>(
    'UPDATE webhook_tokens SET is_active = false WHERE token = $1 RETURNING id',
    [token]
  );

  return !!result;
}

/**
 * Generate webhook URL for email replies
 */
export function generateEmailWebhookUrl(token: string, baseUrl?: string): string {
  const apiBaseUrl = baseUrl || process.env.API_BASE_URL || 'http://localhost:3001';
  return `${apiBaseUrl}/api/webhooks/inbound/email/${token}`;
}

/**
 * Generate webhook URL for SMS replies
 * Uses PUBLIC_WEBHOOK_URL if available (required for Twilio), otherwise falls back to API_BASE_URL
 */
export function generateSMSWebhookUrl(token: string, baseUrl?: string): string {
  // For SMS/Twilio, we need a publicly accessible URL
  // Prefer PUBLIC_WEBHOOK_URL if set, otherwise use provided baseUrl or API_BASE_URL
  const apiBaseUrl = baseUrl || process.env.PUBLIC_WEBHOOK_URL || process.env.API_BASE_URL || 'http://localhost:3001';
  return `${apiBaseUrl}/api/webhooks/inbound/sms/${token}`;
}

/**
 * Generate Reply-To email address with token
 * Format: reply-{token}@yourdomain.com
 */
export function generateReplyToEmail(token: string, domain?: string): string {
  const replyDomain = domain || process.env.REPLY_EMAIL_DOMAIN || 'reply.yourdomain.com';
  return `reply-${token}@${replyDomain}`;
}

/**
 * Get or create a campaign-level webhook token
 * Campaign-level tokens are scoped to a campaign but not to a specific contact
 */
export async function getOrCreateCampaignWebhookToken(
  accountId: string,
  campaignId: string,
  type: 'email' | 'sms' | 'both',
  createdBy?: string | null
): Promise<WebhookToken> {
  // First, try to find an existing active token for this campaign
  const existing = await queryOne<WebhookToken>(
    `SELECT * FROM webhook_tokens 
     WHERE account_id = $1 
     AND campaign_id = $2 
     AND contact_id IS NULL 
     AND type = $3 
     AND is_active = true 
     AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
     ORDER BY created_at DESC
     LIMIT 1`,
    [accountId, campaignId, type]
  );

  if (existing) {
    return existing;
  }

  // Create a new token if none exists
  return await createWebhookToken({
    account_id: accountId,
    campaign_id: campaignId,
    contact_id: null,
    activity_id: null,
    type,
    expires_at: null, // Campaign tokens don't expire
    created_by: createdBy || null,
  });
}

