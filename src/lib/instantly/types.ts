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
