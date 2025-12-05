-- Migration: Add account_id to activities table for company scoping
-- This migration adds company scoping to activities for proper data isolation

-- Add account_id column
ALTER TABLE activities ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_activities_account_id ON activities(account_id);

-- Backfill existing activities with account_id from related entities
-- For activities related to contacts
UPDATE activities a
SET account_id = c.account_id
FROM contacts c
WHERE a.related_to_type = 'contact' 
  AND a.related_to_id = c.id
  AND a.account_id IS NULL;

-- For activities related to accounts
UPDATE activities a
SET account_id = acc.id
FROM accounts acc
WHERE a.related_to_type = 'account' 
  AND a.related_to_id = acc.id
  AND a.account_id IS NULL;

-- For activities related to deals
UPDATE activities a
SET account_id = d.account_id
FROM deals d
WHERE a.related_to_type = 'deal' 
  AND a.related_to_id = d.id
  AND a.account_id IS NULL;

