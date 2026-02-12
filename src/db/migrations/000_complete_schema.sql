-- CRMatIQ CRM Complete Database Schema
-- Consolidated migration combining all migrations 001-018
-- Use this script to set up a new database from scratch

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Accounts/Companies table (created first - no dependencies on other tables, only self-reference)
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    website VARCHAR(255),
    industry VARCHAR(100),
    phone VARCHAR(50),
    email VARCHAR(255),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100),
    postal_code VARCHAR(20),
    parent_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    owner_id UUID, -- Will add foreign key constraint after users table is created
    account_score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Users table (created after accounts, references accounts)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    role VARCHAR(50) DEFAULT 'viewer' CHECK (role IN ('super_admin', 'admin', 'manager', 'viewer')),
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id);

-- Add foreign key constraint for accounts.owner_id (after users table exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'accounts_owner_id_fkey'
    ) THEN
        ALTER TABLE accounts ADD CONSTRAINT accounts_owner_id_fkey 
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Contacts table (without phone and tags - removed in migration 013)
CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    mobile VARCHAR(50),
    job_title VARCHAR(100),
    department VARCHAR(100),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    lifecycle_stage VARCHAR(50) DEFAULT 'lead' CHECK (lifecycle_stage IN ('lead', 'qualified', 'customer', 'churned')),
    notes TEXT,
    custom_fields JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_account_id ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_id ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_lifecycle_stage ON contacts(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts(account_id, lifecycle_stage, created_at);

-- Deals table
CREATE TABLE IF NOT EXISTS deals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    stage VARCHAR(50) DEFAULT 'lead' CHECK (stage IN ('lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost')),
    value DECIMAL(15, 2) DEFAULT 0,
    probability INTEGER DEFAULT 0 CHECK (probability >= 0 AND probability <= 100),
    expected_close_date DATE,
    actual_close_date DATE,
    currency VARCHAR(3) DEFAULT 'USD',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deals_account_id ON deals(account_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals(owner_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_pipeline ON deals(account_id, stage, created_at);
CREATE INDEX IF NOT EXISTS idx_deals_revenue ON deals(account_id, stage, actual_close_date) WHERE stage = 'closed_won';

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    related_to_type VARCHAR(50) CHECK (related_to_type IN ('contact', 'account', 'deal')),
    related_to_id UUID,
    due_date TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
    priority VARCHAR(50) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Activities table (with account_id from migration 008)
CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL CHECK (type IN ('call', 'email', 'sms', 'meeting', 'note', 'task', 'survey')),
    subject VARCHAR(255),
    description TEXT,
    related_to_type VARCHAR(50) CHECK (related_to_type IN ('contact', 'account', 'deal')),
    related_to_id UUID,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activities_related_to ON activities(related_to_type, related_to_id);
CREATE INDEX IF NOT EXISTS idx_activities_performed_by ON activities(performed_by);
CREATE INDEX IF NOT EXISTS idx_activities_created_at ON activities(created_at);
CREATE INDEX IF NOT EXISTS idx_activities_account_id ON activities(account_id);
CREATE INDEX IF NOT EXISTS idx_activities_campaign ON activities(related_to_type, related_to_id, account_id, created_at) WHERE related_to_type = 'campaign';
-- Note: Removed idx_activities_type_status index as activities table doesn't have a status column

-- Surveys table (with development_status from migration 014)
CREATE TABLE IF NOT EXISTS surveys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    questions JSONB NOT NULL,
    development_status VARCHAR(20) DEFAULT 'stable' CHECK (development_status IN ('stable', 'beta', 'under_development', 'deprecated')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Survey responses table
CREATE TABLE IF NOT EXISTS survey_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    survey_id UUID REFERENCES surveys(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    responses JSONB NOT NULL,
    sentiment_score DECIMAL(3, 2),
    ai_analysis TEXT,
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_survey_id ON survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_contact_id ON survey_responses(contact_id);

-- Campaigns table (with description from 009, type nullable from 012, instructions from 015, custom_introduction from 016)
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) CHECK (type IN ('reactivation', 'marketing', 'survey')),
    channel VARCHAR(50) NOT NULL CHECK (channel IN ('email', 'sms', 'call', 'multi')),
    status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed')),
    description TEXT,
    instructions TEXT,
    custom_introduction TEXT,
    use_custom_introduction BOOLEAN DEFAULT false,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN campaigns.type IS 'Deprecated: Campaigns are now generic. Use metadata.contact_group_ids for targeting and metadata.survey_id or metadata.template_id for content.';
COMMENT ON COLUMN campaigns.custom_introduction IS 'Custom introduction text that can be used as a greeting in voice calls or prepended to email/SMS content';
COMMENT ON COLUMN campaigns.use_custom_introduction IS 'Whether to use the custom introduction (toggle)';

CREATE INDEX IF NOT EXISTS idx_campaigns_status_dates ON campaigns(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON campaigns(created_by);

-- Templates table (from migration 002)
CREATE TABLE IF NOT EXISTS templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('email', 'sms')),
    subject VARCHAR(255),
    body TEXT NOT NULL,
    variables TEXT[] DEFAULT '{}',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);
CREATE INDEX IF NOT EXISTS idx_templates_created_by ON templates(created_by);

-- Contact Groups table (from migration 011)
CREATE TABLE IF NOT EXISTS contact_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_group_members (
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    contact_group_id UUID REFERENCES contact_groups(id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (contact_id, contact_group_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact_id ON contact_group_members(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_group_members_group_id ON contact_group_members(contact_group_id);
CREATE INDEX IF NOT EXISTS idx_contact_groups_account_id ON contact_groups(account_id);
CREATE INDEX IF NOT EXISTS idx_contact_groups_created_by ON contact_groups(created_by);

-- Webhook configurations table (from migration 005)
CREATE TABLE IF NOT EXISTS webhook_configurations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE NOT NULL,
    provider VARCHAR(50) NOT NULL CHECK (provider IN ('resend', 'sendgrid', 'twilio')),
    webhook_url VARCHAR(500) NOT NULL,
    secret_key VARCHAR(255),
    event_types TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_webhook_config_account_id ON webhook_configurations(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_config_provider ON webhook_configurations(provider);

-- Webhook tokens table (from migration 005)
CREATE TABLE IF NOT EXISTS webhook_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token VARCHAR(255) UNIQUE NOT NULL,
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE NOT NULL,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    activity_id UUID REFERENCES activities(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('email', 'sms', 'both')),
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_tokens_token ON webhook_tokens(token);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_account_id ON webhook_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_campaign_id ON webhook_tokens(campaign_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_contact_id ON webhook_tokens(contact_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_activity_id ON webhook_tokens(activity_id);
CREATE INDEX IF NOT EXISTS idx_webhook_tokens_is_active ON webhook_tokens(is_active) WHERE is_active = true;

-- AI agent configurations table (complete with all columns from migrations 006, 007, 010, 018)
-- Note: campaign_id removed per migration 007, unique constraint on account_id only
CREATE TABLE IF NOT EXISTS ai_agent_configurations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    agent_id VARCHAR(255) NOT NULL,
    agent_phone_number_id VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    kb_campaigns_document_id VARCHAR(255),
    kb_deals_document_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(account_id)
);

COMMENT ON COLUMN ai_agent_configurations.agent_phone_number_id IS 'ElevenLabs phone number ID for native Twilio outbound calls (one per company)';

CREATE INDEX IF NOT EXISTS idx_ai_agent_config_account_id ON ai_agent_configurations(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_is_active ON ai_agent_configurations(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_kb_campaigns_doc_id ON ai_agent_configurations(kb_campaigns_document_id) WHERE kb_campaigns_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_kb_deals_doc_id ON ai_agent_configurations(kb_deals_document_id) WHERE kb_deals_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_config_phone_number_id ON ai_agent_configurations(agent_phone_number_id) WHERE agent_phone_number_id IS NOT NULL;

-- Triggers to automatically update updated_at
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_updated_at') THEN
        CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_accounts_updated_at') THEN
        CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_contacts_updated_at') THEN
        CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_deals_updated_at') THEN
        CREATE TRIGGER update_deals_updated_at BEFORE UPDATE ON deals
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_tasks_updated_at') THEN
        CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_surveys_updated_at') THEN
        CREATE TRIGGER update_surveys_updated_at BEFORE UPDATE ON surveys
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_campaigns_updated_at') THEN
        CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_templates_updated_at') THEN
        CREATE TRIGGER update_templates_updated_at BEFORE UPDATE ON templates
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_webhook_config_updated_at') THEN
        CREATE TRIGGER update_webhook_config_updated_at BEFORE UPDATE ON webhook_configurations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_ai_agent_config_updated_at') THEN
        CREATE TRIGGER update_ai_agent_config_updated_at BEFORE UPDATE ON ai_agent_configurations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Contact groups trigger
CREATE OR REPLACE FUNCTION update_contact_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_contact_groups_updated_at') THEN
        CREATE TRIGGER update_contact_groups_updated_at
            BEFORE UPDATE ON contact_groups
            FOR EACH ROW
            EXECUTE FUNCTION update_contact_groups_updated_at();
    END IF;
END $$;
