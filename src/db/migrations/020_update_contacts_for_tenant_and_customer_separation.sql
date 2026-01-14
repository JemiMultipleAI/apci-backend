-- Migration: Update contacts table for tenant and customer separation
-- Purpose: Add tenant_id for multi-tenant isolation and rename account_id to customer_company_id for clarity
-- Contacts need both: tenant_id (which tenant owns this contact) and customer_company_id (which customer company the contact belongs to)

-- Step 1: Add tenant_id column to contacts (for multi-tenant isolation)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant_companies(id) ON DELETE CASCADE;

-- Step 2: Rename account_id to customer_company_id (for customer company relationship)
ALTER TABLE contacts RENAME COLUMN account_id TO customer_company_id;

-- Step 3: Update foreign key constraint for customer_company_id
ALTER TABLE contacts 
  DROP CONSTRAINT IF EXISTS contacts_account_id_fkey;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_customer_company_id_fkey
  FOREIGN KEY (customer_company_id)
  REFERENCES customer_companies(id) ON DELETE SET NULL;

-- Step 4: Migrate tenant_id from existing data (based on owner's tenant)
UPDATE contacts c
SET tenant_id = (
  SELECT u.tenant_id 
  FROM users u 
  WHERE u.id = c.owner_id 
  LIMIT 1
)
WHERE c.tenant_id IS NULL AND c.owner_id IS NOT NULL;

-- Step 5: Update indexes
DROP INDEX IF EXISTS idx_contacts_account_id;
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_customer_company_id ON contacts(customer_company_id);

-- Step 6: Update composite index from migration 017
DROP INDEX IF EXISTS idx_contacts_search;
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts(tenant_id, customer_company_id, lifecycle_stage, created_at);
