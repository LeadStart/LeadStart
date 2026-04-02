// Instantly.ai API v2 response types

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface InstantlyCampaignListResponse {
  items: InstantlyCampaign[];
  next_starting_after?: string;
}

export interface InstantlyAnalytics {
  campaign_id: string;
  campaign_name: string;
  total_leads: number;
  contacted: number;
  emails_sent: number;
  replies: number;
  bounced: number;
  unsubscribed: number;
  meetings_booked?: number;
}

export interface InstantlyDailyAnalytics {
  date: string;
  emails_sent: number;
  replies: number;
  bounced: number;
  unsubscribed: number;
  new_leads_contacted: number;
  meetings_booked?: number;
}

export interface InstantlyAnalyticsResponse {
  campaign_id?: string;
  data: InstantlyDailyAnalytics[];
}

export interface InstantlyLead {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  company_domain?: string;
  status: number;
  lead_status?: string;
  email_reply_count: number;
  email_open_count: number;
  email_click_count: number;
  timestamp_created: string;
  timestamp_updated: string;
  payload?: Record<string, unknown>;
}

export interface InstantlyLeadListResponse {
  items: InstantlyLead[];
  next_starting_after?: string;
}

// ===== INBOX / ACCOUNT TYPES =====

export interface InstantlyAccount {
  email: string;
  first_name?: string;
  last_name?: string;
  status: number; // 1 = active
  warmup_status: number;
  created_at: string;
}

export interface InstantlyAccountListResponse {
  items: InstantlyAccount[];
  next_starting_after?: string;
}

export interface InstantlyAccountDailyAnalytics {
  email: string;
  date: string;
  sent: number;
}

export interface InstantlyAccountDailyResponse {
  data: InstantlyAccountDailyAnalytics[];
}

export interface InstantlyWarmupAnalytics {
  email: string;
  sent: number;
  landed_inbox: number;
  landed_spam: number;
  received: number;
  health_score: number;
  health_score_label: string;
}

export interface InstantlyAccountCampaignMapping {
  email: string;
  campaign_id: string;
  campaign_name: string;
}

export interface InstantlyAccountCampaignMappingResponse {
  items: InstantlyAccountCampaignMapping[];
  next_starting_after?: string;
}

// Step-level analytics from /campaigns/analytics/steps
export interface InstantlyStepAnalytics {
  campaign_id: string;
  step: number | null;
  variant: number | null;
  sent: number;
  opened: number;
  unique_opened: number;
  replies: number;
  unique_replies: number;
  replies_automatic: number;
  unique_replies_automatic: number;
  clicks: number;
  unique_clicks: number;
  opportunities?: number;
  unique_opportunities?: number;
}

// ===== EMAIL / UNIBOX TYPES =====

export interface InstantlyEmail {
  id: string;
  timestamp_created: string;
  timestamp_email: string;
  message_id?: string;
  subject?: string;
  body?: { text?: string; html?: string } | string;
  content_preview?: string;
  from_address_email: string;
  to_address_email_list?: string[];
  campaign_id?: string;
  lead?: string;
  ue_type?: number;
  step?: number;
  is_unread?: boolean;
  ai_interest_value?: number;
  thread_id?: string;
}

export interface InstantlyEmailListResponse {
  items: InstantlyEmail[];
  next_starting_after?: string;
}

export interface InstantlyWebhookPayload {
  event_type: string;
  timestamp: string;
  campaign_id?: string;
  campaign_name?: string;
  email?: string;
  lead_email?: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  step?: number;
  workspace_id?: string;
  [key: string]: unknown;
}
