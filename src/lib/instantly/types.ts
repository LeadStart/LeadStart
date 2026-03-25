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
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  status: string;
  lead_status?: string;
  campaign_id: string;
  created_at: string;
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
