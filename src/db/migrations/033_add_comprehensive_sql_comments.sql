-- Migration: Add comprehensive table and column comments
-- Purpose: Improve developer understanding by documenting what each table and column does
-- This has zero breaking changes and improves code maintainability

-- ============================================================================
-- CORE TABLES - Multi-Tenant & User Management
-- ============================================================================

COMMENT ON TABLE tenant_companies IS 'Companies using the CRM platform (multi-tenant isolation). Each tenant company is a separate organization using the CRM.';
COMMENT ON COLUMN tenant_companies.id IS 'Unique identifier for the tenant company';
COMMENT ON COLUMN tenant_companies.name IS 'Name of the tenant company';
COMMENT ON COLUMN tenant_companies.subscription_tier IS 'Subscription tier/plan for the tenant company';
COMMENT ON COLUMN tenant_companies.is_active IS 'Whether the tenant company subscription is active';

COMMENT ON TABLE users IS 'Employees/users of tenant companies who access the CRM. Each user belongs to one tenant company.';
COMMENT ON COLUMN users.id IS 'Unique identifier for the user';
COMMENT ON COLUMN users.email IS 'User email address (unique, used for login)';
COMMENT ON COLUMN users.tenant_id IS 'Tenant company this user belongs to (references tenant_companies.id)';
COMMENT ON COLUMN users.role IS 'User role: super_admin, admin, manager, sales_rep, or viewer';

COMMENT ON TABLE customer_companies IS 'Companies being managed in the CRM (customers of tenant companies). These are the businesses that tenant companies are managing relationships with.';
COMMENT ON COLUMN customer_companies.id IS 'Unique identifier for the customer company';
COMMENT ON COLUMN customer_companies.name IS 'Name of the customer company';
COMMENT ON COLUMN customer_companies.tenant_id IS 'Tenant company that owns/manages this customer company (for multi-tenant isolation)';
COMMENT ON COLUMN customer_companies.customer_company_id IS 'Parent customer company if this is a subsidiary (self-referential)';
COMMENT ON COLUMN customer_companies.owner_id IS 'User who owns/manages this customer company (references users.id)';

-- ============================================================================
-- CRM DATA TABLES - Contacts, Deals
-- ============================================================================

COMMENT ON TABLE contacts IS 'People at customer companies (leads, qualified prospects, customers, churned customers). Can also represent employees of customer companies.';
COMMENT ON COLUMN contacts.id IS 'Unique identifier for the contact';
COMMENT ON COLUMN contacts.tenant_id IS 'Tenant company that owns this contact (for multi-tenant data isolation)';
COMMENT ON COLUMN contacts.customer_company_id IS 'Customer company this contact belongs to (companies being managed in CRM). NULL if contact is not associated with a company.';
COMMENT ON COLUMN contacts.first_name IS 'Contact first name';
COMMENT ON COLUMN contacts.last_name IS 'Contact last name';
COMMENT ON COLUMN contacts.email IS 'Contact email address';
COMMENT ON COLUMN contacts.mobile IS 'Contact mobile phone number (used for SMS and voice calls)';
COMMENT ON COLUMN contacts.lifecycle_stage IS 'Contact lifecycle stage: lead, qualified, customer, or churned';
COMMENT ON COLUMN contacts.owner_id IS 'User who owns/manages this contact (references users.id)';
COMMENT ON COLUMN contacts.tags IS 'JSONB array of tag names for flexible contact segmentation (e.g., ["VIP", "Newsletter", "Enterprise"]). Replaces contact groups.';
COMMENT ON COLUMN contacts.custom_fields IS 'JSONB object for storing custom/arbitrary contact fields';

COMMENT ON TABLE deals IS 'Sales opportunities/pipeline deals with customer companies. Tracks the sales process from lead to close.';
COMMENT ON COLUMN deals.id IS 'Unique identifier for the deal';
COMMENT ON COLUMN deals.name IS 'Deal name/title';
COMMENT ON COLUMN deals.tenant_id IS 'Tenant company that owns this deal (for multi-tenant isolation)';
COMMENT ON COLUMN deals.customer_company_id IS 'Customer company associated with this deal (references customer_companies.id)';
COMMENT ON COLUMN deals.contact_id IS 'Primary contact for this deal (references contacts.id)';
COMMENT ON COLUMN deals.owner_id IS 'User who owns/manages this deal (references users.id)';
COMMENT ON COLUMN deals.stage IS 'Deal stage: lead, qualified, proposal, negotiation, closed_won, or closed_lost';
COMMENT ON COLUMN deals.value IS 'Deal value/amount (in cents or base currency units)';
COMMENT ON COLUMN deals.probability IS 'Probability of closing (0-100 percentage)';

-- ============================================================================
-- ACTIVITY & INTERACTION TABLES
-- ============================================================================

COMMENT ON TABLE activities IS 'Unified log of all customer interactions and activities: calls, emails (sent/received), SMS (sent/received), notes, meetings, tasks, and surveys. Provides complete audit trail and activity history.';
COMMENT ON COLUMN activities.id IS 'Unique identifier for the activity';
COMMENT ON COLUMN activities.type IS 'Type of interaction: call, email, sms, meeting, note, task, or survey';
COMMENT ON COLUMN activities.tenant_id IS 'Tenant company that owns this activity (for multi-tenant isolation)';
COMMENT ON COLUMN activities.subject IS 'Activity subject/title';
COMMENT ON COLUMN activities.description IS 'Activity description/content (e.g., email body, call notes, task description)';
COMMENT ON COLUMN activities.related_to_type IS 'Type of related entity: contact, customer_company, or deal (polymorphic relationship)';
COMMENT ON COLUMN activities.related_to_id IS 'UUID of the related entity (matches related_to_type). Example: if related_to_type="contact", this is a contact.id';
COMMENT ON COLUMN activities.performed_by IS 'User who performed this activity (references users.id). For tasks, this is typically the assignee.';
COMMENT ON COLUMN activities.assigned_to_user_id IS 'User assigned to this task (only used when type = "task", references users.id)';
COMMENT ON COLUMN activities.due_date IS 'Due date for tasks (only used when type = "task")';
COMMENT ON COLUMN activities.priority IS 'Priority level for tasks: low, medium, high, urgent (only used when type = "task")';
COMMENT ON COLUMN activities.task_status IS 'Status of task: pending, in_progress, completed, cancelled (only used when type = "task")';
COMMENT ON COLUMN activities.metadata IS 'JSONB field storing interaction-specific data. Examples: email headers, call duration, SMS provider IDs, campaign context, webhook tokens, original activity references, etc.';
COMMENT ON COLUMN activities.created_at IS 'Timestamp when the activity was created';

-- ============================================================================
-- CAMPAIGN & MARKETING TABLES
-- ============================================================================

COMMENT ON TABLE campaigns IS 'Marketing campaigns that send automated messages to contacts via email, SMS, or voice calls. Uses AI-generated personalized content based on campaign instructions.';
COMMENT ON COLUMN campaigns.id IS 'Unique identifier for the campaign';
COMMENT ON COLUMN campaigns.name IS 'Campaign name';
COMMENT ON COLUMN campaigns.description IS 'Campaign description';
COMMENT ON COLUMN campaigns.channel IS 'Communication channel: email, sms, call, or multi (multiple channels)';
COMMENT ON COLUMN campaigns.status IS 'Campaign status: draft, scheduled, running, paused, or completed';
COMMENT ON COLUMN campaigns.instructions IS 'AI prompt/instructions for generating personalized campaign content. Replaces the deprecated templates table.';
COMMENT ON COLUMN campaigns.custom_introduction IS 'Custom introduction/greeting text that can be prepended to AI-generated content';
COMMENT ON COLUMN campaigns.use_custom_introduction IS 'Toggle to enable/disable custom introduction';
COMMENT ON COLUMN campaigns.start_date IS 'Campaign start date/time';
COMMENT ON COLUMN campaigns.end_date IS 'Campaign end date/time';
COMMENT ON COLUMN campaigns.metadata IS 'JSONB field storing campaign configuration: contact selection criteria (tag_filters, group_ids for backward compat), channel-specific settings, followup task configuration, etc.';
COMMENT ON COLUMN campaigns.created_by IS 'User who created the campaign (references users.id)';

COMMENT ON TABLE contact_groups IS 'DEPRECATED: Contact segmentation groups. Use contacts.tags (JSONB array) instead for flexible tagging. Kept for backward compatibility and data reference.';
COMMENT ON COLUMN contact_groups.tenant_id IS 'Tenant company that owns this contact group';
COMMENT ON COLUMN contact_groups.name IS 'Contact group name (now used as tag name in contacts.tags)';

-- ============================================================================
-- SURVEY TABLES
-- ============================================================================

COMMENT ON TABLE surveys IS 'Survey/questionnaire definitions. Contains the survey questions in JSONB format.';
COMMENT ON COLUMN surveys.id IS 'Unique identifier for the survey';
COMMENT ON COLUMN surveys.name IS 'Survey name';
COMMENT ON COLUMN surveys.questions IS 'JSONB array containing survey questions and structure';
COMMENT ON COLUMN surveys.is_active IS 'Whether the survey is active and can be sent';
COMMENT ON COLUMN surveys.development_status IS 'Survey development status: stable, beta, under_development, or deprecated';
COMMENT ON COLUMN surveys.created_by IS 'User who created the survey (references users.id)';

COMMENT ON TABLE survey_responses IS 'Contact responses to surveys with AI analysis and sentiment scoring.';
COMMENT ON COLUMN survey_responses.id IS 'Unique identifier for the survey response';
COMMENT ON COLUMN survey_responses.survey_id IS 'Survey this response is for (references surveys.id)';
COMMENT ON COLUMN survey_responses.contact_id IS 'Contact who submitted the response (references contacts.id)';
COMMENT ON COLUMN survey_responses.tenant_id IS 'Tenant company that owns this response (for multi-tenant isolation)';
COMMENT ON COLUMN survey_responses.customer_company_id IS 'Customer company associated with the contact (references customer_companies.id)';
COMMENT ON COLUMN survey_responses.responses IS 'JSONB object containing the actual survey answers';
COMMENT ON COLUMN survey_responses.sentiment_score IS 'AI-generated sentiment score (0.0 to 1.0)';
COMMENT ON COLUMN survey_responses.ai_analysis IS 'AI-generated analysis of the survey response';

-- ============================================================================
-- WEBHOOK & AI CONFIGURATION TABLES
-- ============================================================================

COMMENT ON TABLE webhook_tokens IS 'Tokens for routing inbound email/SMS replies back to correct campaign and contact. Created automatically when campaigns send messages.';
COMMENT ON COLUMN webhook_tokens.id IS 'Unique identifier for the webhook token';
COMMENT ON COLUMN webhook_tokens.token IS 'Unique token string (64-character hex) used in webhook URLs or email Reply-To addresses';
COMMENT ON COLUMN webhook_tokens.tenant_id IS 'Tenant company that owns this token (for multi-tenant isolation)';
COMMENT ON COLUMN webhook_tokens.campaign_id IS 'Campaign this token is associated with (for reply context, references campaigns.id)';
COMMENT ON COLUMN webhook_tokens.contact_id IS 'Contact this token is associated with (for reply context, references contacts.id)';
COMMENT ON COLUMN webhook_tokens.activity_id IS 'Original outbound activity this token relates to (references activities.id)';
COMMENT ON COLUMN webhook_tokens.type IS 'Token type: email, sms, or both';
COMMENT ON COLUMN webhook_tokens.is_active IS 'Whether the token is active (inactive tokens are ignored)';
COMMENT ON COLUMN webhook_tokens.expires_at IS 'Token expiration date (NULL means never expires)';

COMMENT ON TABLE ai_agent_configurations IS 'AI agent configuration per tenant. Stores settings for AI agents that handle customer conversations via email, SMS, and voice.';
COMMENT ON COLUMN ai_agent_configurations.id IS 'Unique identifier for the agent configuration';
COMMENT ON COLUMN ai_agent_configurations.tenant_id IS 'Tenant company this agent configuration belongs to (references tenant_companies.id). One agent per tenant.';
COMMENT ON COLUMN ai_agent_configurations.agent_id IS 'Internal agent ID (e.g., ElevenLabs agent ID or OpenAI model identifier)';
COMMENT ON COLUMN ai_agent_configurations.name IS 'Friendly name for the agent (e.g., "Customer Support Bot")';
COMMENT ON COLUMN ai_agent_configurations.description IS 'Agent description/notes';
COMMENT ON COLUMN ai_agent_configurations.kb_campaigns_document_id IS 'Knowledge base document ID for campaigns context (ElevenLabs integration)';
COMMENT ON COLUMN ai_agent_configurations.kb_deals_document_id IS 'Knowledge base document ID for deals context (ElevenLabs integration)';
COMMENT ON COLUMN ai_agent_configurations.is_active IS 'Whether the agent configuration is active';
