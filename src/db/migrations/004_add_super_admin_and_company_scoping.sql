-- Migration: Add super_admin role and company scoping to users
-- This migration adds the super_admin role and links users to companies via account_id

-- Step 1: Update role constraint to include super_admin
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'admin', 'manager', 'sales_rep', 'viewer'));

-- Step 2: Add account_id column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

-- Step 3: Create index for performance
CREATE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id);

-- Step 4: Data migration - Convert existing admin users to super_admin
-- (Uncomment the line below if you want to convert existing admins to super_admin)
-- UPDATE users SET role = 'super_admin' WHERE role = 'admin';

-- Note: Existing users will have NULL account_id after this migration
-- You may need to manually assign them to companies or create a default company

