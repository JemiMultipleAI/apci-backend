import mongoose, { Schema, Document } from 'mongoose';

export interface IAgentLog extends Document {
  timestamp: Date;
  level: 'error' | 'warn' | 'info';
  contact_id?: string;
  account_id?: string;
  campaign_id?: string;
  agent_config_id?: string;
  channel?: 'email' | 'sms';
  event_type: string;
  error_message?: string;
  error_stack?: string;
  context?: Record<string, any>;
}

const AgentLogSchema = new Schema<IAgentLog>(
  {
    timestamp: { type: Date, default: Date.now, required: true, index: true },
    level: { type: String, enum: ['error', 'warn', 'info'], required: true, index: true },
    contact_id: { type: String, index: true },
    account_id: { type: String, index: true },
    campaign_id: { type: String, index: true },
    agent_config_id: { type: String, index: true },
    channel: { type: String, enum: ['email', 'sms'] },
    event_type: { type: String, required: true, index: true },
    error_message: String,
    error_stack: String,
    context: { type: Schema.Types.Mixed },
  },
  {
    timestamps: false, // We use custom timestamp field
  }
);

// Indexes for common queries
AgentLogSchema.index({ account_id: 1, timestamp: -1 });
AgentLogSchema.index({ contact_id: 1, timestamp: -1 });
AgentLogSchema.index({ campaign_id: 1, timestamp: -1 });
AgentLogSchema.index({ level: 1, timestamp: -1 });

export const AgentLog = mongoose.model<IAgentLog>('AgentLog', AgentLogSchema, 'agentlogs');

