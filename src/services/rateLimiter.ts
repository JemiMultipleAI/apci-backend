import { logger } from '../utils/logger';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory rate limit tracking (per agent_id)
// In production, consider using Redis for distributed systems
const rateLimitMap = new Map<string, RateLimitEntry>();

// Rate limits: requests per minute per agent
const RATE_LIMIT_REQUESTS_PER_MINUTE = 60; // Adjust based on ElevenLabs limits
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Check if agent is rate limited
 */
export function isRateLimited(agentId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(agentId);

  if (!entry) {
    return false;
  }

  // Reset if window expired
  if (now > entry.resetAt) {
    rateLimitMap.delete(agentId);
    return false;
  }

  return entry.count >= RATE_LIMIT_REQUESTS_PER_MINUTE;
}

/**
 * Record a request for rate limiting
 */
export function recordRequest(agentId: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(agentId);

  if (!entry || now > entry.resetAt) {
    // Create new entry or reset expired one
    rateLimitMap.set(agentId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
  } else {
    // Increment count
    entry.count++;
  }
}

/**
 * Get remaining requests in current window
 */
export function getRemainingRequests(agentId: string): number {
  if (!isRateLimited(agentId)) {
    const entry = rateLimitMap.get(agentId);
    if (!entry) {
      return RATE_LIMIT_REQUESTS_PER_MINUTE;
    }
    return Math.max(0, RATE_LIMIT_REQUESTS_PER_MINUTE - entry.count);
  }
  return 0;
}

/**
 * Get time until rate limit resets (in milliseconds)
 */
export function getResetTime(agentId: string): number {
  const entry = rateLimitMap.get(agentId);
  if (!entry) {
    return 0;
  }
  const now = Date.now();
  return Math.max(0, entry.resetAt - now);
}

/**
 * Clear rate limit for an agent (useful for testing)
 */
export function clearRateLimit(agentId: string): void {
  rateLimitMap.delete(agentId);
}

/**
 * Clear all rate limits (useful for testing)
 */
export function clearAllRateLimits(): void {
  rateLimitMap.clear();
}

