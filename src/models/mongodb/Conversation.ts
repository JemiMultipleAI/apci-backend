import mongoose, { Schema, Document } from 'mongoose';

export interface IConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  message_id?: string;
}

export interface IConversation extends Document {
  contact_id: string;
  account_id: string;
  campaign_id?: string;
  channel: 'email' | 'sms';
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
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    contact_id: { type: String, required: true, index: true },
    account_id: { type: String, required: true, index: true },
    campaign_id: { type: String, index: true },
    channel: { type: String, enum: ['email', 'sms'], required: true, index: true },
    messages: { type: [ConversationMessageSchema], default: [] },
    created_at: { type: Date, default: Date.now, required: true },
    updated_at: { type: Date, default: Date.now, required: true },
  },
  {
    timestamps: false, // We use custom timestamp fields
  }
);

// Indexes for common queries
ConversationSchema.index({ contact_id: 1, updated_at: -1 });
ConversationSchema.index({ account_id: 1, updated_at: -1 });
ConversationSchema.index({ campaign_id: 1, updated_at: -1 });
ConversationSchema.index({ contact_id: 1, channel: 1, updated_at: -1 });

// Update updated_at before saving
ConversationSchema.pre('save', function (this: IConversation, next: () => void) {
  this.updated_at = new Date();
  next();
});

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema, 'conversations');

