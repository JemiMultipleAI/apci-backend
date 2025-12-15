-- Fix users role constraint and default value
-- This migration fixes the issue where the default role was 'user' but the constraint only allows specific values

-- First, update any existing users with invalid 'user' role to 'viewer'
UPDATE users SET role = 'viewer' WHERE role = 'user' OR role NOT IN ('admin', 'manager', 'sales_rep', 'viewer');

-- Alter the table to change the default value
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'viewer';

-- The CHECK constraint should already be in place, but we'll ensure it's correct
-- Drop the existing constraint if it exists and recreate it
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'sales_rep', 'viewer'));




