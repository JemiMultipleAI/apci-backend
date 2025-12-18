-- Remove phone and tags columns from contacts table
-- Phone is redundant with mobile (mobile is used for SMS/voice calls)
-- Tags are replaced by contact groups

-- Remove phone column
ALTER TABLE contacts DROP COLUMN IF EXISTS phone;

-- Remove tags column
ALTER TABLE contacts DROP COLUMN IF EXISTS tags;

-- Note: This migration removes columns. Existing data in these columns will be lost.
-- Make sure to migrate any important data before running this migration.

