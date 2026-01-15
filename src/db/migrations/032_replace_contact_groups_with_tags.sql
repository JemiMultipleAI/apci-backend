-- Migration: Replace contact_groups with JSONB tags on contacts
-- Purpose: Simplify contact segmentation by using JSONB tags array instead of junction table.
-- More flexible and easier to query. Contact groups table can be kept for backward compatibility
-- or removed if not needed.

-- Step 1: Add tags column to contacts (JSONB array for flexibility)
ALTER TABLE contacts 
  ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;

-- Step 2: Create GIN index for efficient tag queries
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin 
  ON contacts USING GIN (tags);

-- Step 3: Migrate existing contact groups to tags
-- This converts group names to tag names
UPDATE contacts c
SET tags = (
  SELECT COALESCE(jsonb_agg(cg.name), '[]'::jsonb)
  FROM contact_group_members cgm
  JOIN contact_groups cg ON cgm.contact_group_id = cg.id
  WHERE cgm.contact_id = c.id
)
WHERE EXISTS (
  SELECT 1 FROM contact_group_members WHERE contact_id = c.id
);

-- Step 4: Store group-to-tag mapping in contact_groups table metadata for reference
-- (Optional: Add a metadata column to contact_groups if it doesn't exist)
-- ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
-- UPDATE contact_groups SET metadata = jsonb_build_object('migrated_to_tags', true, 'tag_name', name);

-- Step 5: Update campaigns.metadata to support both group_ids and tag_filters
-- Note: Application code should be updated to:
--   - Convert group_ids to tag names when querying
--   - Support new tag_filters format: {"tag_filters": ["VIP", "Newsletter"]}
--   - Migration script for campaigns metadata (run in application code):
--     For each campaign with metadata.contact_group_ids:
--       1. Look up group names
--       2. Convert to tag_filters array
--       3. Store in metadata.tag_filters

-- Step 6: Drop junction table (contact_group_members)
DROP TABLE IF EXISTS contact_group_members CASCADE;

-- Step 7: Clean up junction table indexes
DROP INDEX IF EXISTS idx_contact_group_members_contact_id;
DROP INDEX IF EXISTS idx_contact_group_members_group_id;

-- Step 8: OPTIONAL - Drop contact_groups table if no longer needed
-- Uncomment the following lines if you want to completely remove contact groups:
-- DROP TABLE IF EXISTS contact_groups CASCADE;
-- DROP INDEX IF EXISTS idx_contact_groups_tenant_id;
-- DROP INDEX IF EXISTS idx_contact_groups_created_by;

-- Note: If keeping contact_groups table, it's now just for reference/history.
-- New segmentation should use contacts.tags directly.

-- Usage examples for tags:
-- Find contacts with specific tag:
--   SELECT * FROM contacts WHERE tags @> '["VIP"]'::jsonb;
-- Find contacts with any of multiple tags:
--   SELECT * FROM contacts WHERE tags ?| ARRAY['VIP', 'Newsletter'];
-- Find contacts with all specified tags:
--   SELECT * FROM contacts WHERE tags @> '["VIP", "Newsletter"]'::jsonb;
