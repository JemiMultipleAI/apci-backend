-- Migration: Update activities table for tenant separation
-- Purpose: Rename account_id to tenant_id for multi-tenant isolation
-- Activities belong to a tenant company (for data isolation)

-- Step 1: Rename account_id to tenant_id
ALTER TABLE activities RENAME COLUMN account_id TO tenant_id;

-- Step 2: Update foreign key constraint
ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_account_id_fkey;
ALTER TABLE activities
  ADD CONSTRAINT activities_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES tenant_companies(id) ON DELETE SET NULL;

-- Step 3: Update indexes
DROP INDEX IF EXISTS idx_activities_account_id;
CREATE INDEX IF NOT EXISTS idx_activities_tenant_id ON activities(tenant_id);

-- Step 4: Update composite indexes from migration 017
DROP INDEX IF EXISTS idx_activities_campaign;
CREATE INDEX IF NOT EXISTS idx_activities_campaign ON activities(related_to_type, related_to_id, tenant_id, created_at) 
WHERE related_to_type = 'campaign';

DROP INDEX IF EXISTS idx_activities_type_status;
CREATE INDEX IF NOT EXISTS idx_activities_type_status ON activities(type, status, tenant_id);
