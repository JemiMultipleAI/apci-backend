-- Migration: Add webhook tables for inbound email and SMS routing
-- This migration creates tables for managing inbound webhook tokens with company scoping

-- Webhook configurations per company
CREATE TABLE IF NOT EXISTS webhook_configurations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE NOT NULL, -- Company ID
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('resend', 'sendgrid', 'twilio')),
    webhook_url VARCHAR(500) NOT NULL, -- Company-specific webhook URL (optional, for forwarding)
    secret_key VARCHAR(255), -- For webhook signature verification
    event_types TEXT[] DEFAULT '{}', -- Which events to receive (empty = all events)
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, provider) -- One webhook config per company per provider
);

-- Indexes for webhook configurations
CREATE INDEX IF NOT EXISTS idx_webhook_config_account_id ON webhook_configurations(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_config_provider ON webhook_configurations(provider);

-- Trigger to update updated_at for webhook_configurations
CREATE TRIGGER update_webhook_config_updated_at BEFORE UPDATE ON webhook_configurations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Webhook tokens table for inbound email/SMS routing
CREATE TABLE IF NOT EXISTS webhook_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token VARCHAR(255) UNIQUE NOT NULL,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE NOT NULL, -- Company ID
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    activity_id UUID REFERENCES activities(id) ON DELETE SET NULL, -- Original outbound activity
    type VARCHAR(50) NOT NULL CHECK (type IN ('email', 'sms', 'both')),
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes for webhook tokens
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_token ON webhook_tokens(token);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_account_id ON webhook_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_campaign_id ON webhook_tokens(campaign_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_contact_id ON webhook_tokens(contact_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_activity_id ON webhook_tokens(activity_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_is_active ON webhook_tokens(is_active) WHERE is_active = true;

