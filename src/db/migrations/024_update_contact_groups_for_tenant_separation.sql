-- Migration: Update contact_groups table for tenant separation
-- Purpose: Rename account_id to tenant_id for multi-tenant isolation
-- Contact groups belong to a tenant company (for data isolation)

-- Step 1: Rename account_id to tenant_id
ALTER TABLE contact_groups RENAME COLUMN account_id TO tenant_id;

-- Step 2: Update foreign key constraint
ALTER TABLE contact_groups
  DROP CONSTRAINT IF EXISTS contact_groups_account_id_fkey;
ALTER TABLE contact_groups
  ADD CONSTRAINT contact_groups_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES tenant_companies(id) ON DELETE CASCADE;

-- Step 3: Update indexes
DROP INDEX IF EXISTS idx_contact_groups_account_id;
CREATE INDEX IF NOT EXISTS idx_contact_groups_tenant_id ON contact_groups(tenant_id);
