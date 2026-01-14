-- Migration: Update deals table for tenant and customer separation
-- Purpose: Add tenant_id for multi-tenant isolation and rename account_id to customer_company_id for clarity
-- Deals need both: tenant_id (which tenant owns this deal) and customer_company_id (which customer company the deal is with)

-- Step 1: Add tenant_id column to deals (for multi-tenant isolation)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant_companies(id) ON DELETE CASCADE;

-- Step 2: Rename account_id to customer_company_id (for customer company relationship)
ALTER TABLE deals RENAME COLUMN account_id TO customer_company_id;

-- Step 3: Update foreign key constraint for customer_company_id
ALTER TABLE deals
  DROP CONSTRAINT IF EXISTS deals_account_id_fkey;
ALTER TABLE deals
  ADD CONSTRAINT deals_customer_company_id_fkey
  FOREIGN KEY (customer_company_id)
  REFERENCES customer_companies(id) ON DELETE CASCADE;

-- Step 4: Migrate tenant_id from existing data (based on owner's tenant)
UPDATE deals d
SET tenant_id = (
  SELECT u.tenant_id
  FROM users u
  WHERE u.id = d.owner_id
  LIMIT 1
)
WHERE d.tenant_id IS NULL AND d.owner_id IS NOT NULL;

-- Step 5: Update indexes
DROP INDEX IF EXISTS idx_deals_account_id;
CREATE INDEX IF NOT EXISTS idx_deals_tenant_id ON deals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deals_customer_company_id ON deals(customer_company_id);

-- Step 6: Update composite indexes from migration 017
DROP INDEX IF EXISTS idx_deals_pipeline;
CREATE INDEX IF NOT EXISTS idx_deals_pipeline ON deals(tenant_id, customer_company_id, stage, created_at);

DROP INDEX IF EXISTS idx_deals_revenue;
CREATE INDEX IF NOT EXISTS idx_deals_revenue ON deals(tenant_id, customer_company_id, stage, actual_close_date) 
WHERE stage = 'closed_won';
