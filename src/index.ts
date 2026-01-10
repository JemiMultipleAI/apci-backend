import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { testConnection } from './db/connection';
import { errorHandler } from './middleware/errorHandler';
import { notFoundHandler } from './middleware/notFoundHandler';
import { requestLogger } from './middleware/requestLogger';
import contactsRouter from './routes/contacts';
import accountsRouter from './routes/accounts';
import dealsRouter from './routes/deals';
import tasksRouter from './routes/tasks';
import activitiesRouter from './routes/activities';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import surveysRouter from './routes/surveys';
import campaignsRouter from './routes/campaigns';
import dormantContactsRouter from './routes/dormant-contacts';
import contactGroupsRouter from './routes/contact-groups';
import analyticsRouter from './routes/analytics';
import aiRouter from './routes/ai';
import templatesRouter from './routes/templates';
import importExportRouter from './routes/import-export';
import bulkOperationsRouter from './routes/bulk-operations';
import webhooksRouter, { setupMediaStreamsWebSocket } from './routes/webhooks';
import aiAgentConfigsRouter from './routes/ai-agent-configs';
import knowledgeBaseRouter from './routes/knowledge-base';
import { connectMongoDB, disconnectMongoDB } from './db/mongodb';
// Import campaign queue to initialize workers
import './services/campaignQueue';
import { initializeRedisConnection } from './services/campaignQueue';
import { query } from './db/connection';

const app = express();

/**
 * Periodic check for campaigns that should be marked as completed
 * Runs every 5 minutes to check campaigns past end_date
 */
async function checkCompletedCampaigns() {
  try {
    const campaigns = await query<{
      id: string;
      status: string;
      end_date: Date | string | null;
      metadata: string;
    }>(
      `SELECT id, status, end_date, metadata 
       FROM campaigns 
       WHERE status IN ('running', 'paused') 
       AND end_date IS NOT NULL 
       AND end_date <= CURRENT_TIMESTAMP`
    );

    const now = new Date();

    for (const campaign of campaigns) {
      const metadata = typeof campaign.metadata === 'string' 
        ? JSON.parse(campaign.metadata) 
        : campaign.metadata;

      const totalJobs = metadata.total_jobs || 0;
      const completedJobs = metadata.completed_jobs || 0;
      const failedJobs = metadata.failed_jobs || 0;
      const processedJobs = completedJobs + failedJobs;

      // Mark as completed if all jobs are processed
      if (totalJobs > 0 && processedJobs >= totalJobs) {
        await query(
          'UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['completed', campaign.id]
        );
        console.log(`[CAMPAIGN] Auto-completed campaign ${campaign.id} (end_date passed, all jobs done)`);
      }
    }
  } catch (error: any) {
    console.error('[CAMPAIGN] Error checking completed campaigns:', error.message);
  }
}

// Run check every 5 minutes
setInterval(checkCompletedCampaigns, 5 * 60 * 1000);

// Middleware
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (should be after body parsing but before routes)
console.log('🔵 [SERVER] Request logger middleware registered');
app.use(requestLogger);

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbConnected = await testConnection();
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    database: dbConnected ? 'connected' : 'disconnected',
  });
});

// API routes
app.get('/api', (req, res) => {
  res.json({
        message: 'CRMatIQ API - AI Powered Customer Intelligence',
    version: '1.0.0',
  });
});

// Core CRM routes
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/deals', dealsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/activities', activitiesRouter);

// Agent routes
app.use('/api/surveys', surveysRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/dormant-contacts', dormantContactsRouter);
app.use('/api/contact-groups', contactGroupsRouter);

// Analytics & AI routes
app.use('/api/analytics', analyticsRouter);
app.use('/api/ai', aiRouter);

// Templates
app.use('/api/templates', templatesRouter);

// Import/Export
app.use('/api/import-export', importExportRouter);

// Bulk Operations
app.use('/api/bulk-operations', bulkOperationsRouter);

// Webhooks (public endpoints, signature verification handled in routes)
app.use('/api/webhooks', webhooksRouter);

// AI Agent Configurations (super_admin only)
app.use('/api/ai-agent-configs', aiAgentConfigsRouter);

// Knowledge Base (public endpoints for ElevenLabs)
app.use('/api/knowledge-base', knowledgeBaseRouter);

// Error handling middleware (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const PORT = parseInt(env.PORT, 10);

const startServer = async () => {
  try {
    // Test database connection
    await testConnection();
    
    // Initialize Redis connection (with timeout, non-blocking)
    await initializeRedisConnection();
    
    // Connect to MongoDB (optional, will warn if not configured)
    await connectMongoDB().catch((error) => {
      console.warn('⚠️  MongoDB connection failed (optional):', error.message);
    });
    
    // Create HTTP server but don't start listening yet
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 API: ${env.API_BASE_URL}`);
      console.log(`🌍 Environment: ${env.NODE_ENV}`);
      
      // Log AI Provider configuration
      const aiProvider = env.AI_AGENT_PROVIDER || 'elevenlabs';
      const openAIKey = (env.OPENAI_API_KEY || '').trim();
      const hasOpenAIKey = openAIKey.length > 0;
      const isProjectKey = openAIKey.startsWith('sk-proj-');
      const isOpenRouter = openAIKey.startsWith('sk-or-');
      const keyType = isProjectKey ? 'Project Key' : isOpenRouter ? 'OpenRouter' : 'Standard';
      const fallbackDisabled = env.DISABLE_ELEVENLABS_FALLBACK === true;
      
      console.log(`\n🤖 AI Agent Provider Configuration:`);
      console.log(`   Provider: ${aiProvider.toUpperCase()}`);
      if (aiProvider === 'openai') {
        if (hasOpenAIKey) {
          console.log(`   ✅ OpenAI API Key: ${keyType} - ${openAIKey.substring(0, 15)}...`);
          console.log(`   Model: ${env.OPENAI_MODEL}`);
          console.log(`   Base URL: ${env.OPENAI_BASE_URL || 'https://api.openai.com/v1 (default)'}`);
          console.log(`   Status: Ready to use OpenAI`);
          if (fallbackDisabled) {
            console.log(`   ⚠️  Fallback: DISABLED - OpenAI errors will NOT fallback to ElevenLabs`);
          } else {
            console.log(`   🔄 Fallback: ENABLED - Will fallback to ElevenLabs if OpenAI fails`);
          }
        } else {
          console.log(`   ⚠️  OpenAI API Key: NOT SET`);
          if (fallbackDisabled) {
            console.log(`   ❌ Fallback: DISABLED - System will fail if OpenAI is not configured`);
          } else {
            console.log(`   Will fallback to ElevenLabs`);
          }
        }
      } else {
        console.log(`   ✅ Using ElevenLabs (default provider)`);
        if (hasOpenAIKey) {
          console.log(`   ℹ️  Note: OpenAI API key is set but AI_AGENT_PROVIDER is not 'openai'`);
        }
      }
      console.log(``);
    });
    
    // Setup WebSocket server BEFORE server starts accepting connections
    // This ensures it's ready when Twilio tries to connect
    setupMediaStreamsWebSocket(server);
    
    // Small delay to ensure WebSocket server is fully initialized
    await new Promise(resolve => setTimeout(resolve, 100));
    
    console.log('✅ WebSocket server ready for Media Streams');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await disconnectMongoDB();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await disconnectMongoDB();
  process.exit(0);
});

startServer();
