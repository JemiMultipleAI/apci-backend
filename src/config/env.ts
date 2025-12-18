import { z, ZodError } from 'zod';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment variable schema
const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3001'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),
  PUBLIC_WEBHOOK_URL: z.string().url().optional(), // Public URL for webhooks (required for Twilio, Resend, etc.) - must be HTTPS in production

  // Database - PostgreSQL
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().default('5432'),
  DB_NAME: z.string().default('apci_db'),
  DB_USER: z.string().default('user'),
  DB_PASSWORD: z.string().default('password'),
  DB_POOL_MIN: z.string().default('2'),
  DB_POOL_MAX: z.string().default('10'),

  // Redis
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379'),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.string().optional(), // Set to 'true' or '1' to enable TLS

  // MongoDB
  MONGODB_URI: z.string().optional(),

  // Authentication
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // AI Services
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Voice Service
  VOICE_PROVIDER: z.enum(['elevenlabs', 'twilio']).optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  // STT Service (Speech-to-Text)
  STT_PROVIDER: z.enum(['elevenlabs', 'deepgram', 'google', 'twilio']).optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  GOOGLE_CLOUD_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // Email Service
  EMAIL_PROVIDER: z.enum(['sendgrid', 'resend']).optional(),
  SENDGRID_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  REPLY_EMAIL_DOMAIN: z.string().optional(), // Domain for Reply-To email addresses (e.g., reply.yourdomain.com)

  // SMS Service
  SMS_PROVIDER: z.enum(['twilio']).optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // File Storage
  STORAGE_TYPE: z.enum(['local', 's3', 'r2']).default('local'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().optional(),
  CLOUDFLARE_R2_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_R2_ACCESS_KEY: z.string().optional(),
  CLOUDFLARE_R2_SECRET_KEY: z.string().optional(),
  CLOUDFLARE_R2_BUCKET: z.string().optional(),

  // Monitoring
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Knowledge Base
  KNOWLEDGE_BASE_SECRET: z.string().default('change-me-in-production-min-32-chars'),
});

// Parse and validate environment variables
const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof ZodError) {
      console.error('❌ Invalid environment variables:');
      error.issues.forEach((err: z.ZodIssue) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
};

export const env = parseEnv();

// Helper to get database connection string
export const getDatabaseUrl = (): string => {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  return `postgresql://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
};

// Helper to get Redis connection config
export const getRedisConfig = () => {
  if (env.REDIS_URL) {
    return { url: env.REDIS_URL };
  }
  return {
    host: env.REDIS_HOST,
    port: parseInt(env.REDIS_PORT, 10),
    password: env.REDIS_PASSWORD || undefined,
  };
};

