import { AgentLog } from '../models/mongodb/AgentLog';
import { logger } from '../utils/logger';

export interface LogAgentErrorOptions {
  level: 'error' | 'warn' | 'info';
  contactId?: string;
  accountId?: string;
  campaignId?: string;
  agentConfigId?: string;
  channel?: 'email' | 'sms';
  eventType: string;
  errorMessage?: string;
  errorStack?: string;
  context?: Record<string, any>;
}

/**
 * Log agent-related events to MongoDB
 */
export async function logAgentEvent(options: LogAgentErrorOptions): Promise<void> {
  if (!isMongoDBAvailable()) {
    logger.warn('MongoDB not available, skipping agent log', options);
    return;
  }

  try {
    await AgentLog.create({
      timestamp: new Date(),
      level: options.level,
      contact_id: options.contactId,
      account_id: options.accountId,
      campaign_id: options.campaignId,
      agent_config_id: options.agentConfigId,
      channel: options.channel,
      event_type: options.eventType,
      error_message: options.errorMessage,
      error_stack: options.errorStack,
      context: options.context,
    });
  } catch (error: any) {
    logger.error('Failed to log agent event to MongoDB', {
      error: error.message,
      eventType: options.eventType,
    });
  }
}

/**
 * Check if MongoDB is available
 */
function isMongoDBAvailable(): boolean {
  try {
    const mongoose = require('mongoose');
    return mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
}

