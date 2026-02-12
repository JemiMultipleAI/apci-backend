-- Migration: Remove sales_rep role
-- This migration updates existing sales_rep users to manager role and removes sales_rep from the role constraint

-- Update existing sales_rep users to manager role
UPDATE users SET role = 'manager' WHERE role = 'sales_rep';

-- Update the role constraint to remove sales_rep
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('super_admin', 'admin', 'manager', 'viewer'));
