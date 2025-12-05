import { Pool, PoolConfig } from 'pg';
import { env, getDatabaseUrl } from '../config/env';

// Get database URL to check if it's a cloud database (Neon, etc.)
const databaseUrl = getDatabaseUrl();
const isCloudDatabase = databaseUrl.includes('neon.tech') || 
                        databaseUrl.includes('supabase.co') ||
                        databaseUrl.includes('aws.neon.tech');

// Create PostgreSQL connection pool
const poolConfig: PoolConfig = {
  connectionString: databaseUrl,
  min: parseInt(env.DB_POOL_MIN, 10),
  max: parseInt(env.DB_POOL_MAX, 10),
  // For cloud databases, use longer timeouts and keep connections alive
  idleTimeoutMillis: isCloudDatabase ? 60000 : 30000, // 60s for cloud, 30s for local
  connectionTimeoutMillis: isCloudDatabase ? 10000 : 2000, // 10s for cloud, 2s for local
  // Enable SSL for cloud databases
  ssl: isCloudDatabase ? { rejectUnauthorized: false } : false,
  // Keep connections alive with periodic pings
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

// Create the pool
const pool = new Pool(poolConfig);

// Handle pool errors gracefully (don't exit the process)
// Cloud databases like Neon can terminate idle connections, which is normal
pool.on('error', (err) => {
  console.error('⚠️ [DB] Pool error (this is usually harmless for cloud databases):', err.message);
  // Don't exit - the pool will handle reconnection automatically
  // Only log critical errors that might need attention
  if (err.message.includes('password authentication failed') || 
      err.message.includes('database') && err.message.includes('does not exist')) {
    console.error('❌ [DB] Critical database error - check your connection settings');
  }
});

// Test database connection
export const testConnection = async (): Promise<boolean> => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    console.log('✅ Database connected successfully:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
};

// Execute a query with automatic retry on connection errors
export const query = async <T = any>(
  text: string,
  params?: any[],
  retries = 2
): Promise<T[]> => {
  const start = Date.now();
  let lastError: any;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      if (env.NODE_ENV === 'development') {
        console.log('Executed query', { text, duration, rows: res.rowCount });
      }
      return res.rows as T[];
    } catch (error: any) {
      lastError = error;
      
      // Retry on connection errors (common with cloud databases)
      const isConnectionError = 
        error.message?.includes('Connection terminated') ||
        error.message?.includes('Connection ended') ||
        error.message?.includes('Connection closed') ||
        error.code === 'ECONNRESET' ||
        error.code === 'EPIPE';
      
      if (isConnectionError && attempt < retries) {
        const delay = (attempt + 1) * 100; // Exponential backoff: 100ms, 200ms
        console.warn(`⚠️ [DB] Connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Don't retry on other errors or if we've exhausted retries
      console.error('❌ [DB] Query error:', error.message || error);
      throw error;
    }
  }
  
  throw lastError;
};

// Get a single row
export const queryOne = async <T = any>(
  text: string,
  params?: any[]
): Promise<T | null> => {
  const rows = await query<T>(text, params);
  return rows[0] || null;
};

// Transaction helper
export const transaction = async <T>(
  callback: (client: any) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Close the pool (for graceful shutdown)
export const closePool = async (): Promise<void> => {
  await pool.end();
};

export default pool;

