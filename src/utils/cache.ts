import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

let redisClient: Redis | null = null;
let isRedisAvailable = false;

/**
 * Initialize Redis connection for caching
 */
export async function initializeCache(): Promise<void> {
  if (redisClient) {
    return;
  }

  try {
    const redisConfig: any = env.REDIS_URL 
      ? env.REDIS_URL
      : {
          host: env.REDIS_HOST || 'localhost',
          port: parseInt(env.REDIS_PORT || '6379', 10),
          ...(env.REDIS_USERNAME && { username: env.REDIS_USERNAME }),
          ...(env.REDIS_PASSWORD && { password: env.REDIS_PASSWORD }),
          ...(env.REDIS_TLS === 'true' || env.REDIS_TLS === '1'
            ? { tls: { rejectUnauthorized: false } }
            : {}),
          retryStrategy: (times: number) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          maxRetriesPerRequest: 3,
        };

    redisClient = new Redis(redisConfig);

    redisClient.on('connect', () => {
      logger.info('Redis cache connected');
      isRedisAvailable = true;
    });

    redisClient.on('error', (error) => {
      logger.warn('Redis cache error (caching disabled):', error.message);
      isRedisAvailable = false;
    });

    redisClient.on('close', () => {
      logger.warn('Redis cache connection closed');
      isRedisAvailable = false;
    });

    // Test connection
    await redisClient.ping();
    isRedisAvailable = true;
    logger.info('Redis cache initialized successfully');
  } catch (error: any) {
    logger.warn('Redis cache initialization failed (caching disabled):', error.message);
    isRedisAvailable = false;
    redisClient = null;
  }
}

/**
 * Get Redis client (returns null if not available)
 */
export function getCacheClient(): Redis | null {
  return isRedisAvailable ? redisClient : null;
}

/**
 * Check if cache is available
 */
export function isCacheAvailable(): boolean {
  return isRedisAvailable && redisClient !== null;
}

/**
 * Get value from cache
 */
export async function getCache<T>(key: string): Promise<T | null> {
  if (!isCacheAvailable() || !redisClient) {
    return null;
  }

  try {
    const value = await redisClient.get(key);
    if (value) {
      return JSON.parse(value) as T;
    }
    return null;
  } catch (error: any) {
    logger.debug('Cache get error:', error.message);
    return null;
  }
}

/**
 * Set value in cache with TTL (time to live in seconds)
 */
export async function setCache(key: string, value: any, ttlSeconds: number = 300): Promise<boolean> {
  if (!isCacheAvailable() || !redisClient) {
    return false;
  }

  try {
    await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch (error: any) {
    logger.debug('Cache set error:', error.message);
    return false;
  }
}

/**
 * Delete value from cache
 */
export async function deleteCache(key: string): Promise<boolean> {
  if (!isCacheAvailable() || !redisClient) {
    return false;
  }

  try {
    await redisClient.del(key);
    return true;
  } catch (error: any) {
    logger.debug('Cache delete error:', error.message);
    return false;
  }
}

/**
 * Delete multiple keys matching a pattern
 */
export async function deleteCachePattern(pattern: string): Promise<number> {
  if (!isCacheAvailable() || !redisClient) {
    return 0;
  }

  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length === 0) {
      return 0;
    }
    await redisClient.del(...keys);
    return keys.length;
  } catch (error: any) {
    logger.debug('Cache pattern delete error:', error.message);
    return 0;
  }
}

/**
 * Cache wrapper for async functions
 */
export async function withCache<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds: number = 300
): Promise<T> {
  // Try to get from cache
  const cached = await getCache<T>(key);
  if (cached !== null) {
    logger.debug('Cache hit', { key });
    return cached;
  }

  // Execute function and cache result
  logger.debug('Cache miss', { key });
  const result = await fn();
  await setCache(key, result, ttlSeconds);
  return result;
}

/**
 * Close Redis connection
 */
export async function closeCache(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isRedisAvailable = false;
    logger.info('Redis cache connection closed');
  }
}
