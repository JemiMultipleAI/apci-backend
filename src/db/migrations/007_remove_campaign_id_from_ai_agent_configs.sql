-- Migration: Remove campaign_id from ai_agent_configurations
-- This migration simplifies agent configurations to be company-only (no campaign-specific agents)

-- First, delete any existing campaign-specific configurations (they will fall back to company agents)
-- We'll keep only one agent per company (preferring the one without campaign_id if both exist)
DELETE FROM ai_agent_configurations a1
WHERE a1.campaign_id IS NOT NULL
AND EXISTS (
  SELECT 1 FROM ai_agent_configurations a2
  WHERE a2.account_id = a1.account_id
  AND a2.campaign_id IS NULL
  AND a2.id != a1.id
);

-- Drop the unique constraint that includes campaign_id
ALTER TABLE ai_agent_configurations DROP CONSTRAINT IF EXISTS ai_agent_configurations_account_id_campaign_id_key;

-- Drop the campaign_id index
DROP INDEX IF EXISTS idx_ai_agent_config_campaign_id;

-- Remove the campaign_id column
ALTER TABLE ai_agent_configurations DROP COLUMN IF EXISTS campaign_id;

-- Add new unique constraint for account_id only (one agent per company)
ALTER TABLE ai_agent_configurations ADD CONSTRAINT ai_agent_configurations_account_id_key UNIQUE (account_id);

