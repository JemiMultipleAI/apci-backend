-- Migration: Remove campaigns.type column
-- Purpose: The type column is deprecated and not actively used. Campaigns are now generic.
-- This column was made nullable in migration 012 and is no longer needed.

-- Step 1: Drop the type column
ALTER TABLE campaigns DROP COLUMN IF EXISTS type;

-- Step 2: Remove any check constraints related to type (should be auto-dropped, but ensure)
-- The constraint will be automatically dropped with the column

-- Step 3: Verify column is removed
-- Run: SELECT column_name FROM information_schema.columns 
--      WHERE table_name = 'campaigns' AND column_name = 'type';
-- Should return 0 rows
