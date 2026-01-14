-- Migration: Create tenant_companies table
-- Purpose: Separate tenant companies (companies using the CRM) from customer companies (companies being managed)
-- This is the first step in separating multi-tenant isolation from CRM data relationships

-- Step 1: Create tenant_companies table
CREATE TABLE IF NOT EXISTS tenant_companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subscription_tier VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_tenant_companies_name ON tenant_companies(name);
CREATE INDEX IF NOT EXISTS idx_tenant_companies_is_active ON tenant_companies(is_active);

-- Step 3: Migrate existing tenant companies from accounts table
-- Assumption: Accounts that are referenced by users.account_id are tenant companies
-- This migration will create tenant_companies records for each unique account_id in users table
INSERT INTO tenant_companies (id, name, is_active, created_at, updated_at)
SELECT DISTINCT a.id, a.name, true, a.created_at, a.updated_at
FROM accounts a
WHERE a.id IN (SELECT DISTINCT account_id FROM users WHERE account_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM tenant_companies tc WHERE tc.id = a.id);

-- Step 4: Add tenant_id column to users table (keeping account_id temporarily for migration safety)
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant_companies(id) ON DELETE SET NULL;

-- Step 5: Migrate user tenant relationships from account_id to tenant_id
UPDATE users u
SET tenant_id = u.account_id
WHERE u.account_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenant_companies tc WHERE tc.id = u.account_id)
  AND u.tenant_id IS NULL;

-- Step 6: Create index for tenant_id
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

-- Step 7: Add trigger to update updated_at for tenant_companies
CREATE TRIGGER update_tenant_companies_updated_at BEFORE UPDATE ON tenant_companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
