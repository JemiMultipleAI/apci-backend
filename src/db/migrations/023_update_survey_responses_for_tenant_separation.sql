-- Migration: Update survey_responses table for tenant separation
-- Purpose: Add tenant_id for multi-tenant isolation and rename account_id to customer_company_id
-- Survey responses need both: tenant_id (which tenant owns this response) and customer_company_id (which customer company)

-- Step 1: Add tenant_id column
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant_companies(id) ON DELETE SET NULL;

-- Step 2: Rename account_id to customer_company_id
ALTER TABLE survey_responses RENAME COLUMN account_id TO customer_company_id;

-- Step 3: Update foreign key constraint
ALTER TABLE survey_responses
  DROP CONSTRAINT IF EXISTS survey_responses_account_id_fkey;
ALTER TABLE survey_responses
  ADD CONSTRAINT survey_responses_customer_company_id_fkey
  FOREIGN KEY (customer_company_id)
  REFERENCES customer_companies(id) ON DELETE SET NULL;

-- Step 4: Migrate tenant_id from contacts
UPDATE survey_responses sr
SET tenant_id = (
  SELECT c.tenant_id
  FROM contacts c
  WHERE c.id = sr.contact_id
  LIMIT 1
)
WHERE sr.tenant_id IS NULL AND sr.contact_id IS NOT NULL;

-- Step 5: Create indexes
CREATE INDEX IF NOT EXISTS idx_survey_responses_tenant_id ON survey_responses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_customer_company_id ON survey_responses(customer_company_id);
