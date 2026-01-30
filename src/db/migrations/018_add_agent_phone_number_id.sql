-- Migration: Add agent_phone_number_id to ai_agent_configurations
-- This migration adds a column to store ElevenLabs phone number ID for native Twilio outbound calls
-- One phone number per company (company-level configuration)

ALTER TABLE ai_agent_configurations 
ADD COLUMN IF NOT EXISTS agent_phone_number_id VARCHAR(255);

-- Add comment for documentation
COMMENT ON COLUMN ai_agent_configurations.agent_phone_number_id IS 
  'ElevenLabs phone number ID for native Twilio outbound calls (one per company)';

-- Add index for faster lookups (only on non-null values)
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_phone_number_id 
ON ai_agent_configurations(agent_phone_number_id) 
WHERE agent_phone_number_id IS NOT NULL;
