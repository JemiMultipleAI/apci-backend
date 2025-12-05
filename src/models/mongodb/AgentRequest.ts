import mongoose, { Schema, Document } from 'mongoose';

export interface IAgentRequest extends Document {
  timestamp: Date;
  contact_id?: string;
  account_id?: string;
  agent_config_id?: string;
  agent_id: string; // Internal ElevenLabs agent ID
  request_message: string;
  response_message?: string;
  response_time_ms?: number;
  success: boolean;
  error?: string;
  rate_limited: boolean;
}

const AgentRequestSchema = new Schema<IAgentRequest>(
  {
    timestamp: { type: Date, default: Date.now, required: true, index: true },
    contact_id: { type: String, index: true },
    account_id: { type: String, index: true },
    agent_config_id: { type: String, index: true },
    agent_id: { type: String, required: true, index: true },
    request_message: { type: String, required: true },
    response_message: String,
    response_time_ms: Number,
    success: { type: Boolean, required: true, index: true },
    error: String,
    rate_limited: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: false, // We use custom timestamp field
  }
);

// Indexes for common queries
AgentRequestSchema.index({ account_id: 1, timestamp: -1 });
AgentRequestSchema.index({ contact_id: 1, timestamp: -1 });
AgentRequestSchema.index({ agent_id: 1, timestamp: -1 });
AgentRequestSchema.index({ success: 1, timestamp: -1 });

export const AgentRequest = mongoose.model<IAgentRequest>('AgentRequest', AgentRequestSchema, 'agentrequests');

