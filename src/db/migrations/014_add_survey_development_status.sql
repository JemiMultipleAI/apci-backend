-- Add development_status column to surveys table
-- Values: 'stable', 'beta', 'under_development', 'deprecated'
ALTER TABLE surveys 
ADD COLUMN IF NOT EXISTS development_status VARCHAR(20) DEFAULT 'under_development' 
CHECK (development_status IN ('stable', 'beta', 'under_development', 'deprecated'));

-- Update existing surveys to 'stable' (can be changed later)
UPDATE surveys SET development_status = 'stable' WHERE development_status IS NULL OR development_status = 'under_development';
