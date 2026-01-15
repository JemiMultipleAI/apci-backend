// TypeScript interfaces for database entities

export interface User {
  id: string;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  role: 'super_admin' | 'admin' | 'manager' | 'sales_rep' | 'viewer';
  is_active: boolean;
  tenant_id: string | null; // Updated: account_id renamed to tenant_id
  created_at: Date;
  updated_at: Date;
}

export interface Account {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  parent_account_id: string | null;
  owner_id: string | null;
  account_score: number;
  created_at: Date;
  updated_at: Date;
}

export interface Contact {
  id: string;
  tenant_id: string | null; // For multi-tenant isolation
  customer_company_id: string | null; // Updated: account_id renamed to customer_company_id
  first_name: string;
  last_name: string;
  email: string | null;
  mobile: string | null;
  job_title: string | null;
  department: string | null;
  owner_id: string | null;
  lifecycle_stage: 'lead' | 'qualified' | 'customer' | 'churned';
  notes: string | null;
  custom_fields: Record<string, any>;
  tags: string[]; // JSONB array for contact segmentation (replaces contact_groups)
  created_at: Date;
  updated_at: Date;
}

export interface Deal {
  id: string;
  name: string;
  tenant_id: string | null; // For multi-tenant isolation
  customer_company_id: string | null; // Updated: account_id renamed to customer_company_id
  contact_id: string | null;
  owner_id: string | null;
  stage: 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';
  value: number;
  probability: number;
  expected_close_date: Date | null;
  actual_close_date: Date | null;
  currency: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

// DEPRECATED: Tasks are now stored in activities table with type='task'
// This interface is kept for backward compatibility but tasks should query activities
export interface Task {
  id: string;
  title: string; // Maps to activities.subject
  description: string | null; // Maps to activities.description
  assigned_to: string | null; // Maps to activities.assigned_to_user_id
  related_to_type: 'contact' | 'account' | 'deal' | null;
  related_to_id: string | null;
  due_date: Date | null; // Maps to activities.due_date
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; // Maps to activities.task_status
  priority: 'low' | 'medium' | 'high' | 'urgent'; // Maps to activities.priority
  created_at: Date;
  updated_at: Date;
}

export interface Activity {
  id: string;
  type: 'call' | 'email' | 'sms' | 'meeting' | 'note' | 'task' | 'survey';
  subject: string | null;
  description: string | null;
  related_to_type: 'contact' | 'account' | 'deal' | null;
  related_to_id: string | null;
  performed_by: string | null;
  metadata: Record<string, any>;
  // Task-specific fields (only populated when type='task')
  due_date: Date | null;
  assigned_to_user_id: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  task_status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | null;
  created_at: Date;
}

export interface Survey {
  id: string;
  name: string;
  description: string | null;
  questions: any; // JSONB
  created_by: string | null;
  is_active: boolean;
  development_status?: 'stable' | 'beta' | 'under_development' | 'deprecated';
  created_at: Date;
  updated_at: Date;
}

export interface SurveyResponse {
  id: string;
  survey_id: string;
  contact_id: string | null;
  account_id: string | null;
  responses: any; // JSONB
  sentiment_score: number | null;
  ai_analysis: string | null;
  completed_at: Date;
  created_at: Date;
}

// DEPRECATED: Contact groups are now stored as JSONB tags on contacts
// This interface is kept for backward compatibility during migration
// New code should use contact.tags array instead
export interface ContactGroup {
  id: string;
  name: string;
  description: string | null;
  tenant_id: string | null; // Updated: account_id renamed to tenant_id
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  member_count?: number; // Computed field
}

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  // type removed - campaigns are now generic, no type distinction
  channel: 'email' | 'sms' | 'call' | 'multi';
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed';
  created_by: string | null;
  start_date: Date | null;
  end_date: Date | null;
  instructions?: string; // AI prompt/instructions for personalized content generation (replaces templates)
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

