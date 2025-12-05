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
import subscriptionReactivationRouter from './routes/subscription-reactivation';
import analyticsRouter from './routes/analytics';
import aiRouter from './routes/ai';
import templatesRouter from './routes/templates';
import importExportRouter from './routes/import-export';
import bulkOperationsRouter from './routes/bulk-operations';
import webhooksRouter from './routes/webhooks';
import aiAgentConfigsRouter from './routes/ai-agent-configs';
import knowledgeBaseRouter from './routes/knowledge-base';
import { connectMongoDB, disconnectMongoDB } from './db/mongodb';

const app = express();

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
app.use('/api/subscription-reactivation', subscriptionReactivationRouter);

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
    
    // Connect to MongoDB (optional, will warn if not configured)
    await connectMongoDB().catch((error) => {
      console.warn('⚠️  MongoDB connection failed (optional):', error.message);
    });
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 API: ${env.API_BASE_URL}`);
      console.log(`🌍 Environment: ${env.NODE_ENV}`);
    });
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
