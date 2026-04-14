export type AppRole = "owner" | "va" | "client";

export type FeedbackStatus =
  | "good_lead"
  | "bad_lead"
  | "already_contacted"
  | "wrong_person"
  | "interested"
  | "not_interested"
  | "other";

export type CampaignStatus = "active" | "paused" | "completed" | "draft";

export type KPIHealth = "good" | "warning" | "bad";

export interface Organization {
  id: string;
  name: string;
  instantly_api_key: string | null;
  instantly_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: AppRole;
  organization_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  organization_id: string;
  name: string;
  contact_email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientUser {
  client_id: string;
  user_id: string;
  created_at: string;
  invite_status: string;
}

export interface Campaign {
  id: string;
  client_id: string;
  organization_id: string;
  instantly_campaign_id: string;
  name: string;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
}

export interface CampaignSnapshot {
  id: string;
  campaign_id: string;
  snapshot_date: string;
  total_leads: number;
  emails_sent: number;
  replies: number;
  unique_replies: number;
  positive_replies: number;
  bounces: number;
  unsubscribes: number;
  meetings_booked: number;
  new_leads_contacted: number;
  reply_rate: number | null;
  positive_reply_rate: number | null;
  bounce_rate: number | null;
  unsubscribe_rate: number | null;
  raw_data: Record<string, unknown> | null;
  fetched_at: string;
}

export interface LeadFeedback {
  id: string;
  campaign_id: string;
  lead_email: string;
  lead_name: string | null;
  lead_company: string | null;
  status: FeedbackStatus;
  comment: string | null;
  submitted_by: string | null;
  created_at: string;
}

export interface KPIReport {
  id: string;
  client_id: string;
  organization_id: string;
  report_period_start: string;
  report_period_end: string;
  report_data: KPIReportData;
  sent_at: string | null;
  sent_to: string[] | null;
  created_by: string | null;
  created_at: string;
}

export interface KPIReportData {
  client_name: string;
  period: { start: string; end: string };
  campaigns: CampaignKPISummary[];
  totals: KPIMetrics;
}

export interface CampaignKPISummary {
  campaign_name: string;
  campaign_id: string;
  metrics: KPIMetrics;
}

export interface KPIMetrics {
  emails_sent: number;
  replies: number;
  unique_replies: number;
  positive_replies: number;
  bounces: number;
  unsubscribes: number;
  meetings_booked: number;
  reply_rate: number;
  positive_reply_rate: number;
  bounce_rate: number;
  unsubscribe_rate: number;
  reply_to_meeting_rate: number;
}

// Step-level campaign metrics (per-step analytics from Instantly)
export interface CampaignStepMetric {
  id: string;
  campaign_id: string;
  step: number;
  period_start: string;
  period_end: string;
  sent: number;
  replies: number;
  unique_replies: number;
  opens: number;
  unique_opens: number;
  bounces: number;
  reply_rate: number;
  open_rate: number;
  bounce_rate: number;
  fetched_at: string;
}

// Step health — compares current period vs trailing average
export interface StepHealthAlert {
  campaign_id: string;
  campaign_name: string;
  client_name: string;
  step: number;
  metric: string;        // "reply_rate" | "bounce_rate"
  current_value: number;
  baseline_value: number; // trailing average
  change_pct: number;     // negative = drop
  severity: "warning" | "critical";
}

// CRM / Prospects
export type ProspectStage = "lead" | "contacted" | "meeting" | "proposal" | "closed" | "lost";

export interface Prospect {
  id: string;
  organization_id: string;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  industry: string | null;
  stage: ProspectStage;
  deal_notes: string | null;
  follow_up_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  organization_id: string;
  event_type: string;
  campaign_instantly_id: string | null;
  lead_email: string | null;
  payload: Record<string, unknown>;
  processed: boolean;
  excluded: boolean;
  received_at: string;
}

// Contacts (campaign leads)
export type ContactStatus = "new" | "enriched" | "uploaded" | "active" | "bounced" | "replied" | "unsubscribed";

export interface Contact {
  id: string;
  organization_id: string;
  client_id: string | null;
  campaign_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  linkedin_url: string | null;
  intro_line: string | null;
  enrichment_data: Record<string, unknown>;
  tags: string[];
  status: ContactStatus;
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Notifications
export interface Notification {
  id: string;
  user_id: string;
  organization_id: string;
  type: string;
  title: string;
  message: string | null;
  read: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

// Tasks (internal to-do tracking)
export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string | null;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
