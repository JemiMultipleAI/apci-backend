-- Migration: Add knowledge base document IDs to ai_agent_configurations
-- This migration adds columns to store ElevenLabs knowledge base document IDs
-- These are manually entered by super_admin when configuring agents

ALTER TABLE ai_agent_configurations 
ADD COLUMN IF NOT EXISTS kb_campaigns_document_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS kb_deals_document_id VARCHAR(255);

-- Add indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_kb_campaigns_doc_id ON ai_agent_configurations(kb_campaigns_document_id) WHERE kb_campaigns_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_kb_deals_doc_id ON ai_agent_configurations(kb_deals_document_id) WHERE kb_deals_document_id IS NOT NULL;

