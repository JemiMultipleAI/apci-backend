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
import conversationsRouter from './routes/conversations';
import campaignAnalyticsRouter from './routes/campaign-analytics';
import inboxRouter from './routes/inbox';
import callsRouter from './routes/calls';
import templatesRouter from './routes/templates';
import { websocketService } from './services/websocket';
import importExportRouter from './routes/import-export';
import bulkOperationsRouter from './routes/bulk-operations';
import webhooksRouter from './routes/webhooks';
import aiAgentConfigsRouter from './routes/ai-agent-configs';
import knowledgeBaseRouter from './routes/knowledge-base';
import { connectMongoDB, disconnectMongoDB } from './db/mongodb';
// Import campaign queue to initialize workers
import './services/campaignQueue';
import { initializeRedisConnection } from './services/campaignQueue';
import { initializeCache } from './utils/cache';
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
app.get('/health', async (_req, res) => {
  const health: any = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {},
  };

  let overallHealthy = true;

  // Check PostgreSQL
  try {
    const dbConnected = await testConnection();
    health.services.database = dbConnected ? 'connected' : 'disconnected';
    if (!dbConnected) overallHealthy = false;
  } catch (error: any) {
    health.services.database = 'error';
    health.services.databaseError = error.message;
    overallHealthy = false;
  }

  // Check MongoDB
  try {
    const { isMongoDBConnected } = await import('./db/mongodb');
    health.services.mongodb = isMongoDBConnected() ? 'connected' : 'disconnected';
  } catch (error: any) {
    health.services.mongodb = 'error';
    health.services.mongodbError = error.message;
  }

  // Check Redis
  try {
    const { isCacheAvailable } = await import('./utils/cache');
    health.services.redis = isCacheAvailable() ? 'connected' : 'disconnected';
  } catch (error: any) {
    health.services.redis = 'disconnected';
  }

  // Check external services (non-blocking)
  try {
    const { env } = await import('./config/env');
    health.services.external = {
      openai: env.OPENAI_API_KEY ? 'configured' : 'not_configured',
      twilio: env.TWILIO_ACCOUNT_SID ? 'configured' : 'not_configured',
      email: env.EMAIL_PROVIDER ? 'configured' : 'not_configured',
      elevenlabs: env.ELEVENLABS_API_KEY ? 'configured' : 'not_configured',
    };
  } catch (error: any) {
    health.services.external = { error: 'check_failed' };
  }

  health.status = overallHealthy ? 'healthy' : 'degraded';
  res.status(overallHealthy ? 200 : 503).json(health);
});

// API routes
app.get('/api', (_req, res) => {
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
app.use('/api/conversations', conversationsRouter);
app.use('/api/campaign-analytics', campaignAnalyticsRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/calls', callsRouter);

// Templates (DEPRECATED - returns 410 Gone)
// app.use('/api/templates', templatesRouter); // Commented out - templates feature deprecated

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
    
    // Initialize Redis cache (non-blocking)
    await initializeCache().catch((error: any) => {
      console.warn('⚠️  Redis cache initialization failed (optional):', error.message);
    });
    
    // Connect to MongoDB (optional, will warn if not configured)
    await connectMongoDB().catch((error) => {
      console.warn('⚠️  MongoDB connection failed (optional):', error.message);
    });
    
    // Create HTTP server
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 API: ${env.API_BASE_URL}`);
      console.log(`🌍 Environment: ${env.NODE_ENV}`);
      
      // Log AI Provider configuration (OpenAI only now, ElevenLabs agent removed - TTS only)
      const openAIKey = (env.OPENAI_API_KEY || '').trim();
      const hasOpenAIKey = openAIKey.length > 0;
      const isProjectKey = openAIKey.startsWith('sk-proj-');
      const isOpenRouter = openAIKey.startsWith('sk-or-');
      const keyType = isProjectKey ? 'Project Key' : isOpenRouter ? 'OpenRouter' : 'Standard';
      
      console.log(`\n🤖 AI Agent Configuration:`);
      console.log(`   Provider: OpenAI (ElevenLabs agent removed - TTS only)`);
      if (hasOpenAIKey) {
        console.log(`   ✅ OpenAI API Key: ${keyType} - ${openAIKey.substring(0, 15)}...`);
        console.log(`   Model: ${env.OPENAI_MODEL}`);
        console.log(`   Base URL: ${env.OPENAI_BASE_URL || 'https://api.openai.com/v1 (default)'}`);
        console.log(`   Status: Ready`);
      } else {
        console.log(`   ⚠️  OpenAI API Key: NOT SET`);
        console.log(`   ⚠️  Agent functionality will not work without OpenAI API key`);
      }
      console.log(``);
    });
    
    // CRITICAL: Handle WebSocket upgrade requests BEFORE Express processes them
    // This prevents Express middleware from corrupting the WebSocket handshake
    // which causes "Reserved bits are non-zero" protocol violations
    const WebSocket = require('ws');
    let mediaStreamsWss: any = null;
    let generalWss: any = null;
    
    // Setup Media Streams WebSocket server with manual upgrade handling
    try {
      mediaStreamsWss = new WebSocket.Server({
        noServer: true, // CRITICAL: Don't auto-handle upgrades, we'll do it manually
      });
      
      mediaStreamsWss.on('connection', async (ws: any, req: any) => {
        // Extract query parameters
        const fullUrl = req.url || '';
        let customParameters: Record<string, string> = {};
        
        try {
          const url = new URL(fullUrl, `http://${req.headers.host || 'localhost'}`);
          url.searchParams.forEach((value, key) => {
            customParameters[key] = value;
          });
        } catch (error) {
          const queryString = fullUrl.split('?')[1];
          if (queryString) {
            queryString.split('&').forEach((param: string) => {
              const [key, value] = param.split('=');
              if (key && value) {
                customParameters[decodeURIComponent(key)] = decodeURIComponent(value);
              }
            });
          }
        }
        
        // Attach to req for use in handleMediaStreamConnection
        (req as any).customParameters = customParameters;
        
        // Import and use the connection handler
        const { handleMediaStreamConnection } = await import('./services/twilioMediaStreams');
        handleMediaStreamConnection(ws, req);
      });
      
      mediaStreamsWss.on('error', (error: Error) => {
        const { logger } = require('./utils/logger');
        logger.error('[MEDIA_STREAM] WebSocket server error', {
          error: error.message,
          stack: error.stack,
        });
      });
      
      console.log('✅ Media Streams WebSocket server ready (manual upgrade handling)');
    } catch (error: any) {
      console.error('⚠️  Media Streams WebSocket setup failed:', error.message);
    }
    
    // Setup general WebSocket server with manual upgrade handling
    try {
      generalWss = websocketService.initializeWithManualUpgrade();
      console.log('✅ General WebSocket server ready (manual upgrade handling)');
    } catch (error: any) {
      console.error('⚠️  General WebSocket setup failed:', error.message);
    }
    
    // Handle upgrade events manually - this bypasses Express middleware
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`).pathname;
      
      // Route to Twilio Media Streams WebSocket
      if (pathname === '/api/webhooks/twilio/media-streams') {
        if (mediaStreamsWss) {
          mediaStreamsWss.handleUpgrade(request, socket, head, (ws: any) => {
            mediaStreamsWss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
        return;
      }
      
      // Route to general WebSocket server
      if (pathname === '/ws') {
        if (generalWss) {
          generalWss.handleUpgrade(request, socket, head, (ws: any) => {
            generalWss.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
        return;
      }
      
      // For all other paths, close the connection (not a WebSocket path we handle)
      socket.destroy();
    });
    
    console.log('🔌 WebSocket servers initialized with manual upgrade handling');
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
