import { randomUUID } from 'crypto';

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Get or create request ID from request headers
 * Falls back to generating a new one if not present
 */
export function getRequestId(req: { headers?: { [key: string]: string | string[] | undefined } }): string {
  const headerId = req.headers?.['x-request-id'] || req.headers?.['x-correlation-id'];
  if (typeof headerId === 'string') {
    return headerId;
  }
  return generateRequestId();
}
