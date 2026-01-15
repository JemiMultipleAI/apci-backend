-- Migration: Merge tasks table into activities table
-- Purpose: Tasks are a type of activity. Unifying into a single activity stream simplifies queries
-- and provides a unified audit trail. Tasks become activities with type='task'.

-- Step 1: Add task-specific columns to activities table
ALTER TABLE activities 
  ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(50) CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS task_status VARCHAR(50) CHECK (task_status IN ('pending', 'in_progress', 'completed', 'cancelled'));

-- Step 2: Verify activities.type already includes 'task'
-- The constraint should already allow 'task' from migration 001
-- If not, update constraint:
-- ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_type_check;
-- ALTER TABLE activities ADD CONSTRAINT activities_type_check 
--   CHECK (type IN ('call', 'email', 'sms', 'meeting', 'note', 'task', 'survey'));

-- Step 3: Migrate existing tasks to activities
INSERT INTO activities (
  type, 
  subject, 
  description, 
  related_to_type, 
  related_to_id, 
  performed_by, 
  tenant_id,
  due_date, 
  assigned_to_user_id, 
  priority, 
  task_status,
  metadata,
  created_at
)
SELECT 
  'task' as type,
  title as subject,
  description,
  related_to_type,
  related_to_id,
  assigned_to as performed_by,
  -- Get tenant_id from assigned user, or from related entity
  COALESCE(
    (SELECT tenant_id FROM users WHERE id = t.assigned_to),
    (SELECT tenant_id FROM contacts WHERE id = t.related_to_id AND t.related_to_type = 'contact'),
    (SELECT tenant_id FROM deals WHERE id = t.related_to_id AND t.related_to_type = 'deal'),
    (SELECT tenant_id FROM customer_companies WHERE id = t.related_to_id AND t.related_to_type = 'account')
  ) as tenant_id,
  due_date,
  assigned_to as assigned_to_user_id,
  priority,
  status as task_status,
  jsonb_build_object(
    'migrated_from_tasks_table', true, 
    'original_task_id', t.id,
    'original_created_at', t.created_at,
    'original_updated_at', t.updated_at
  ) as metadata,
  created_at
FROM tasks t
WHERE NOT EXISTS (
  -- Avoid duplicates if migration runs twice
  SELECT 1 FROM activities a 
  WHERE a.type = 'task' 
  AND a.metadata->>'original_task_id' = t.id::text
);

-- Step 4: Create indexes for task-specific queries
CREATE INDEX IF NOT EXISTS idx_activities_type_task_status 
  ON activities(type, task_status) 
  WHERE type = 'task';

CREATE INDEX IF NOT EXISTS idx_activities_assigned_to_user 
  ON activities(assigned_to_user_id) 
  WHERE assigned_to_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_due_date 
  ON activities(due_date) 
  WHERE due_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_task_priority 
  ON activities(priority) 
  WHERE type = 'task' AND priority IS NOT NULL;

-- Step 5: Drop tasks table (after migration is complete)
DROP TABLE IF EXISTS tasks CASCADE;

-- Step 6: Clean up tasks-specific indexes (should be auto-dropped, but ensure)
DROP INDEX IF EXISTS idx_tasks_assigned_to;
DROP INDEX IF EXISTS idx_tasks_status;

-- Step 7: Update trigger name if needed (tasks table trigger will be auto-dropped)

-- Note: All code references to tasks table need to be updated to:
-- SELECT * FROM activities WHERE type = 'task'
-- Frontend and backend APIs need to be updated accordingly
