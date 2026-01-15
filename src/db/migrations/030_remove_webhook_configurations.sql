-- Migration: Remove webhook_configurations table
-- Purpose: This table appears to be unused. It was intended for provider webhook configuration
-- but webhook_tokens handle the actual routing. Verify usage before running.

-- Step 1: Verify the table exists and check for data
-- Run this query first:
-- SELECT COUNT(*) as config_count FROM webhook_configurations;
-- If count > 0, review the data before dropping

-- Step 2: Drop webhook_configurations table
DROP TABLE IF EXISTS webhook_configurations CASCADE;

-- Step 3: Drop associated indexes
DROP INDEX IF EXISTS idx_webhook_config_account_id;
DROP INDEX IF EXISTS idx_webhook_config_provider;
DROP INDEX IF EXISTS idx_webhook_configurations_tenant_id;

-- Step 4: Drop trigger if it exists
DROP TRIGGER IF EXISTS update_webhook_config_updated_at ON webhook_configurations;

-- Note: webhook_tokens table is still needed and should remain
