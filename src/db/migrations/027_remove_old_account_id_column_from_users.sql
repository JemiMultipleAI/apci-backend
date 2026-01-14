-- Migration: Remove old account_id column from users table
-- Purpose: Clean up after migration is complete - users now use tenant_id instead of account_id
-- WARNING: Only run this after verifying all data has been migrated and code has been updated

-- Step 1: Verify migration is complete (this is a safety check - comment out if you want to proceed)
-- Uncomment the following to check if any users still have account_id but no tenant_id:
-- SELECT COUNT(*) FROM users WHERE account_id IS NOT NULL AND tenant_id IS NULL;

-- Step 2: Remove old account_id column from users
-- Note: Only do this after all code has been updated to use tenant_id
ALTER TABLE users DROP COLUMN IF EXISTS account_id;

-- Step 3: Drop old index
DROP INDEX IF EXISTS idx_users_account_id;
