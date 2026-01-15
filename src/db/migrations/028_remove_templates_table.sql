-- Migration: Remove templates table
-- Purpose: Templates table is deprecated - campaigns now use AI-generated content via instructions field
-- WARNING: This will remove all template data. Ensure templates are not needed before running.

-- Step 1: Verify no active dependencies
-- Run this query first to check for references:
-- SELECT COUNT(*) as template_references 
-- FROM campaigns 
-- WHERE metadata->>'template_id' IS NOT NULL 
--    OR metadata::text LIKE '%template%';

-- Step 2: Log template count before deletion (for reference)
-- SELECT COUNT(*) as template_count FROM templates;

-- Step 3: Drop templates table and all related objects
DROP TABLE IF EXISTS templates CASCADE;

-- Step 4: Drop associated indexes (should be auto-dropped, but ensure cleanup)
DROP INDEX IF EXISTS idx_templates_type;
DROP INDEX IF EXISTS idx_templates_created_by;

-- Note: Frontend routes (/portal/templates/*) and backend API routes (/api/templates) 
-- should be removed separately in code changes
