-- Migration: Rename accounts table to customer_companies
-- Purpose: Clarify that this table stores customer companies (companies being managed in the CRM), not tenant companies
-- This migration renames the table and adds tenant_id to link customer companies to their tenant

-- Step 1: Rename accounts table to customer_companies
ALTER TABLE accounts RENAME TO customer_companies;

-- Step 2: Add tenant_id column to customer_companies (which tenant owns this customer company)
ALTER TABLE customer_companies ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant_companies(id) ON DELETE CASCADE;

-- Step 3: Rename parent_account_id to parent_customer_company_id for clarity
ALTER TABLE customer_companies RENAME COLUMN parent_account_id TO parent_customer_company_id;

-- Step 4: Update foreign key constraint for parent_customer_company_id
ALTER TABLE customer_companies 
  DROP CONSTRAINT IF EXISTS accounts_parent_account_id_fkey;
ALTER TABLE customer_companies
  ADD CONSTRAINT customer_companies_parent_customer_company_id_fkey 
  FOREIGN KEY (parent_customer_company_id) 
  REFERENCES customer_companies(id) ON DELETE SET NULL;

-- Step 5: Migrate tenant_id for customer_companies
-- Link customer companies to tenant based on the owner's tenant
UPDATE customer_companies cc
SET tenant_id = (
  SELECT u.tenant_id
  FROM users u
  WHERE u.id = cc.owner_id
  LIMIT 1
)
WHERE cc.tenant_id IS NULL AND cc.owner_id IS NOT NULL;

-- Step 6: Create indexes for customer_companies
CREATE INDEX IF NOT EXISTS idx_customer_companies_tenant_id ON customer_companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_companies_parent_customer_company_id ON customer_companies(parent_customer_company_id);

-- Step 7: Update trigger name (rename trigger for updated_at)
DROP TRIGGER IF EXISTS update_accounts_updated_at ON customer_companies;
CREATE TRIGGER update_customer_companies_updated_at BEFORE UPDATE ON customer_companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
