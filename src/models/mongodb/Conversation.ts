import mongoose, { Schema, Document } from 'mongoose';

export interface IConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  message_id?: string; // Provider message ID (email ID, SMS SID, call SID)
  metadata?: {
    sentiment?: number; // 0-1 sentiment score
    tokens_used?: number; // For AI messages
    transcription_id?: string; // For voice calls
    audio_duration_ms?: number; // For voice calls
    delivery_status?: string; // For email/SMS
    [key: string]: any; // Flexible for future fields
  };
}

export interface IConversation extends Document {
  contact_id: string;
  account_id: string;
  campaign_id?: string;
  channel: 'email' | 'sms' | 'call'; // Added 'call' support
  subject?: string; // For email threads
  summary?: string; // AI-generated conversation summary
  thread_id?: string; // For grouping related conversations (optional)
  metadata: {
    thread_type?: 'inbound' | 'outbound' | 'mixed';
    message_count?: number;
    agent_responses?: number;
    user_responses?: number;
    first_message_date?: Date;
    last_message_date?: Date;
    [key: string]: any; // Flexible for future fields
  };
  messages: IConversationMessage[];
  created_at: Date;
  updated_at: Date;
}

const ConversationMessageSchema = new Schema<IConversationMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, required: true },
    message_id: String,
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    contact_id: { type: String, required: true, index: true },
    account_id: { type: String, required: true, index: true },
    campaign_id: { type: String, index: true },
    channel: { type: String, enum: ['email', 'sms', 'call'], required: true, index: true },
    subject: String,
    summary: String,
    thread_id: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    messages: { type: [ConversationMessageSchema], default: [] },
    created_at: { type: Date, default: Date.now, required: true },
    updated_at: { type: Date, default: Date.now, required: true },
  },
  {
    timestamps: false, // We use custom timestamp fields
  }
);

// Indexes for common queries and analytics
ConversationSchema.index({ contact_id: 1, updated_at: -1 });
ConversationSchema.index({ account_id: 1, updated_at: -1 });
ConversationSchema.index({ campaign_id: 1, updated_at: -1 });
ConversationSchema.index({ contact_id: 1, channel: 1, updated_at: -1 });
ConversationSchema.index({ thread_id: 1, updated_at: -1 }); // For threading
ConversationSchema.index({ 'metadata.last_message_date': -1 }); // For analytics

// Update updated_at before saving
ConversationSchema.pre('save', function (this: IConversation, next: () => void) {
  this.updated_at = new Date();
  next();
});

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema, 'conversations');

