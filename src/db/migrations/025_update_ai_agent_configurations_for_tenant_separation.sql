-- Migration: Update ai_agent_configurations table for tenant separation
-- Purpose: Rename account_id to tenant_id for multi-tenant isolation
-- AI agent configurations belong to a tenant company

-- Step 1: Rename account_id to tenant_id
ALTER TABLE ai_agent_configurations RENAME COLUMN account_id TO tenant_id;

-- Step 2: Update foreign key constraint
ALTER TABLE ai_agent_configurations
  DROP CONSTRAINT IF EXISTS ai_agent_configurations_account_id_fkey;
ALTER TABLE ai_agent_configurations
  ADD CONSTRAINT ai_agent_configurations_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES tenant_companies(id) ON DELETE CASCADE;

-- Step 3: Update unique constraint (from account_id to tenant_id)
ALTER TABLE ai_agent_configurations DROP CONSTRAINT IF EXISTS ai_agent_configurations_account_id_key;
ALTER TABLE ai_agent_configurations ADD CONSTRAINT ai_agent_configurations_tenant_id_key UNIQUE (tenant_id);

-- Step 4: Update indexes
DROP INDEX IF EXISTS idx_ai_agent_config_account_id;
CREATE INDEX IF NOT EXISTS idx_ai_agent_configurations_tenant_id ON ai_agent_configurations(tenant_id);
