-- Add instructions column to campaigns
-- This replaces template_id - campaigns can now have AI-generated personalized content
ALTER TABLE campaigns 
ADD COLUMN IF NOT EXISTS instructions TEXT;

-- Note: Keep template_id for backward compatibility
-- Can be removed in a future migration after confirming no dependencies
