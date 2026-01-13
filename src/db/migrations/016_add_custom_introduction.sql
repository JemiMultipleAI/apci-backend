-- Add custom introduction fields to campaigns table
-- This allows campaigns to have a customizable introduction/greeting
-- that can be used in voice calls, emails, and SMS

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS custom_introduction TEXT,
ADD COLUMN IF NOT EXISTS use_custom_introduction BOOLEAN DEFAULT false;

-- Add comment for documentation
COMMENT ON COLUMN campaigns.custom_introduction IS 'Custom introduction text that can be used as a greeting in voice calls or prepended to email/SMS content';
COMMENT ON COLUMN campaigns.use_custom_introduction IS 'Whether to use the custom introduction (toggle)';
