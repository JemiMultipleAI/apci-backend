-- Make campaign type field nullable
-- Campaigns are now generic and type is deprecated (kept for backward compatibility)

ALTER TABLE campaigns 
ALTER COLUMN type DROP NOT NULL;

-- Add a comment to document the deprecation
COMMENT ON COLUMN campaigns.type IS 'Deprecated: Campaigns are now generic. Use metadata.contact_group_ids for targeting and metadata.survey_id or metadata.template_id for content.';

