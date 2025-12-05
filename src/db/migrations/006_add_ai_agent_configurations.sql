-- Migration: Add AI agent configurations table
-- This migration creates a table for storing ElevenLabs agent configurations
-- Only accessible by super_admin users

-- AI agent configurations table
CREATE TABLE IF NOT EXISTS ai_agent_configurations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE, -- Company-scoped
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL, -- Optional: per-campaign
    agent_id VARCHAR(255) NOT NULL,  -- ElevenLabs agent ID (internal, never exposed to companies)
    name VARCHAR(255) NOT NULL,  -- Friendly name for companies (e.g., "Customer Support Bot")
    description TEXT,  -- Optional description
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(account_id, campaign_id)  -- One agent per campaign
);

-- Indexes for AI agent configurations
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_account_id ON ai_agent_configurations(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_campaign_id ON ai_agent_configurations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_is_active ON ai_agent_configurations(is_active) WHERE is_active = true;

-- Trigger to update updated_at for ai_agent_configurations
CREATE TRIGGER update_ai_agent_config_updated_at BEFORE UPDATE ON ai_agent_configurations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

