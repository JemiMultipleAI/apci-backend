// TypeScript interfaces for database entities

export interface User {
  id: string;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  role: 'super_admin' | 'admin' | 'manager' | 'sales_rep' | 'viewer';
  is_active: boolean;
  account_id: string | null;
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
  account_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  job_title: string | null;
  department: string | null;
  owner_id: string | null;
  lifecycle_stage: 'lead' | 'qualified' | 'customer' | 'churned';
  tags: string[];
  notes: string | null;
  custom_fields: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface Deal {
  id: string;
  name: string;
  account_id: string | null;
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

export interface Task {
  id: string;
  title: string;
  description: string | null;
  assigned_to: string | null;
  related_to_type: 'contact' | 'account' | 'deal' | null;
  related_to_id: string | null;
  due_date: Date | null;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
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
  created_at: Date;
}

export interface Survey {
  id: string;
  name: string;
  description: string | null;
  questions: any; // JSONB
  created_by: string | null;
  is_active: boolean;
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

export interface Campaign {
  id: string;
  name: string;
  description: string | null;
  type: 'reactivation' | 'marketing' | 'survey';
  channel: 'email' | 'sms' | 'call' | 'multi';
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed';
  created_by: string | null;
  start_date: Date | null;
  end_date: Date | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

