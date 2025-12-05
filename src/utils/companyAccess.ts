import { TokenPayload } from './jwt';
import { queryOne } from '../db/connection';
import { logger } from './logger';

/**
 * Check if user is super_admin
 */
export function isSuperAdmin(user: TokenPayload | { role?: string }): boolean {
  return user.role === 'super_admin';
}

/**
 * Get user's company ID from database
 * Note: This should be cached in request context (req.userCompanyId) to avoid repeated queries
 */
export async function getUserCompanyId(user: TokenPayload): Promise<string | null> {
  try {
    const result = await queryOne<{ account_id: string | null }>(
      'SELECT account_id FROM users WHERE id = $1',
      [user.userId]
    );
    return result?.account_id || null;
  } catch (error) {
    logger.error('Failed to get user company ID:', error);
    return null;
  }
}

/**
 * Check if user has access to a specific company
 */
export async function hasCompanyAccess(user: TokenPayload, accountId: string): Promise<boolean> {
  // Super_admin has access to all companies
  if (isSuperAdmin(user)) {
    return true;
  }

  // Get user's company ID
  const userCompanyId = await getUserCompanyId(user);
  
  // User can only access their own company
  return userCompanyId === accountId;
}

/**
 * Get effective company ID for filtering
 * - If super_admin and providedCompanyId, use providedCompanyId (optional filter)
 * - If super_admin and no providedCompanyId, return null (no filter)
 * - If not super_admin, use user's company_id (ignore providedCompanyId for security)
 * 
 * @param user - User token payload
 * @param providedCompanyId - Optional company_id from query params
 * @param cachedCompanyId - Optional cached company_id from request context (preferred)
 */
export async function getEffectiveCompanyId(
  user: TokenPayload,
  providedCompanyId?: string,
  cachedCompanyId?: string | null
): Promise<string | null> {
  if (isSuperAdmin(user)) {
    return providedCompanyId || null;
  }

  // Use cached company_id if available, otherwise fetch from DB
  if (cachedCompanyId !== undefined) {
    return cachedCompanyId;
  }

  // Fallback to JWT company_id if available
  if (user.companyId !== undefined) {
    return user.companyId;
  }

  // Last resort: fetch from database
  return await getUserCompanyId(user);
}

/**
 * Build WHERE clause for company filtering
 */
export async function buildCompanyFilter(
  user: TokenPayload,
  providedCompanyId?: string,
  tableAlias: string = ''
): Promise<{ clause: string; value: string | null }> {
  const effectiveCompanyId = await getEffectiveCompanyId(user, providedCompanyId);
  
  if (effectiveCompanyId === null) {
    // No filter (super_admin viewing all)
    return { clause: '', value: null };
  }

  const column = tableAlias ? `${tableAlias}.account_id` : 'account_id';
  return { clause: `AND ${column} = $1`, value: effectiveCompanyId };
}

