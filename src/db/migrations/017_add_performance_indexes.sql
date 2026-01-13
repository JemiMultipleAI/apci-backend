-- Performance optimization indexes
-- Add missing indexes for better query performance

-- Activities table: Add account_id index for company filtering
CREATE INDEX IF NOT EXISTS idx_activities_account_id ON activities(account_id);

-- Activities table: Composite index for campaign analytics
CREATE INDEX IF NOT EXISTS idx_activities_campaign ON activities(related_to_type, related_to_id, account_id, created_at) 
WHERE related_to_type = 'campaign';

-- Activities table: Index for type and status filtering
CREATE INDEX IF NOT EXISTS idx_activities_type_status ON activities(type, status, account_id);

-- Campaigns table: Index for status and date filtering
CREATE INDEX IF NOT EXISTS idx_campaigns_status_dates ON campaigns(status, start_date, end_date);

-- Campaigns table: Index for created_by for company filtering
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON campaigns(created_by);

-- Contacts table: Composite index for search
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts(account_id, lifecycle_stage, created_at);

-- Deals table: Composite index for pipeline queries
CREATE INDEX IF NOT EXISTS idx_deals_pipeline ON deals(account_id, stage, created_at);

-- Deals table: Index for revenue analytics
CREATE INDEX IF NOT EXISTS idx_deals_revenue ON deals(account_id, stage, actual_close_date) 
WHERE stage = 'closed_won';
