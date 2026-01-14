-- Migration: Update webhook tables for tenant separation
-- Purpose: Rename account_id to tenant_id in webhook_configurations, webhook_tokens, and webhook_events
-- Webhook tables belong to tenant companies (for multi-tenant isolation)

-- Step 1: Update webhook_configurations table
ALTER TABLE webhook_configurations RENAME COLUMN account_id TO tenant_id;
ALTER TABLE webhook_configurations
  DROP CONSTRAINT IF EXISTS webhook_configurations_account_id_fkey;
ALTER TABLE webhook_configurations
  ADD CONSTRAINT webhook_configurations_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES tenant_companies(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS idx_webhook_config_account_id;
CREATE INDEX IF NOT EXISTS idx_webhook_configurations_tenant_id ON webhook_configurations(tenant_id);

-- Update unique constraint (account_id, provider) -> (tenant_id, provider)
ALTER TABLE webhook_configurations DROP CONSTRAINT IF EXISTS webhook_configurations_account_id_provider_key;
ALTER TABLE webhook_configurations ADD CONSTRAINT webhook_configurations_tenant_id_provider_key UNIQUE(tenant_id, provider);

-- Step 2: Update webhook_tokens table
ALTER TABLE webhook_tokens RENAME COLUMN account_id TO tenant_id;
ALTER TABLE webhook_tokens
  DROP CONSTRAINT IF EXISTS webhook_tokens_account_id_fkey;
ALTER TABLE webhook_tokens
  ADD CONSTRAINT webhook_tokens_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES tenant_companies(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS idx_webhook_tokens_account_id;
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_tenant_id ON webhook_tokens(tenant_id);

-- Step 3: Update webhook_events table (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'webhook_events') THEN
    ALTER TABLE webhook_events RENAME COLUMN account_id TO tenant_id;
    ALTER TABLE webhook_events
      DROP CONSTRAINT IF EXISTS webhook_events_account_id_fkey;
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_tenant_id_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES tenant_companies(id) ON DELETE CASCADE;
    
    DROP INDEX IF EXISTS idx_webhook_events_account_id;
    CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant_id ON webhook_events(tenant_id);
  END IF;
END $$;
