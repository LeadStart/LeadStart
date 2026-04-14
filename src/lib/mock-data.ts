import type {
  Client,
  Campaign,
  CampaignSnapshot,
  LeadFeedback,
  KPIReport,
  WebhookEvent,
  Profile,
  Organization,
  Prospect,
} from "@/types/app";

// ---------- Organization ----------
export const MOCK_ORG: Organization = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "LeadStart Agency",
  instantly_api_key: "demo_key_placeholder",
  instantly_workspace_id: "demo_workspace",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

// ---------- Profiles ----------
export const MOCK_PROFILES: Profile[] = [
  {
    id: "user-owner-001",
    email: "admin@leadstart.com",
    full_name: "Daniel (Owner)",
    role: "owner",
    organization_id: MOCK_ORG.id,
    is_active: true,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "user-va-001",
    email: "va@leadstart.com",
    full_name: "Sarah (VA)",
    role: "va",
    organization_id: MOCK_ORG.id,
    is_active: true,
    created_at: "2025-02-01T00:00:00Z",
    updated_at: "2025-02-01T00:00:00Z",
  },
];

// ---------- Clients ----------
export const MOCK_CLIENTS: Client[] = [
  {
    id: "client-001",
    organization_id: MOCK_ORG.id,
    name: "Acme Corp",
    contact_email: "john@acmecorp.com",
    notes: "Real estate investor — focus on commercial leads",
    report_interval_days: 7,
    report_schedule_start: "2025-03-03",
    report_last_sent_at: "2025-03-17T15:00:00Z",
    report_recipients: ["john@acmecorp.com"],
    created_at: "2025-01-15T00:00:00Z",
    updated_at: "2025-03-01T00:00:00Z",
  },
  {
    id: "client-002",
    organization_id: MOCK_ORG.id,
    name: "TechStartup Inc",
    contact_email: "lisa@techstartup.io",
    notes: "SaaS founder — targeting CTOs at mid-market companies",
    report_interval_days: null,
    report_schedule_start: null,
    report_last_sent_at: null,
    report_recipients: null,
    created_at: "2025-02-01T00:00:00Z",
    updated_at: "2025-03-10T00:00:00Z",
  },
  {
    id: "client-003",
    organization_id: MOCK_ORG.id,
    name: "GrowthCo Marketing",
    contact_email: "mike@growthco.com",
    notes: "New client — onboarding in progress",
    report_interval_days: null,
    report_schedule_start: null,
    report_last_sent_at: null,
    report_recipients: null,
    created_at: "2025-03-15T00:00:00Z",
    updated_at: "2025-03-15T00:00:00Z",
  },
];

// ---------- Client Users (join table) ----------
export const MOCK_CLIENT_USERS = [
  { client_id: "client-001", user_id: "user-client-001", created_at: "2025-01-15T00:00:00Z", invite_status: "active" },
  { client_id: "client-001", user_id: "user-client-001b", created_at: "2025-02-20T00:00:00Z", invite_status: "active" },
  { client_id: "client-002", user_id: "user-client-002", created_at: "2025-02-01T00:00:00Z", invite_status: "active" },
];

// ---------- Campaigns ----------
export const MOCK_CAMPAIGNS: Campaign[] = [
  {
    id: "camp-001",
    client_id: "client-001",
    organization_id: MOCK_ORG.id,
    instantly_campaign_id: "inst_camp_abc123",
    name: "Acme — Commercial RE Investors Q1",
    status: "active",
    created_at: "2025-01-20T00:00:00Z",
    updated_at: "2025-03-01T00:00:00Z",
  },
  {
    id: "camp-002",
    client_id: "client-001",
    organization_id: MOCK_ORG.id,
    instantly_campaign_id: "inst_camp_def456",
    name: "Acme — Multifamily Owners",
    status: "active",
    created_at: "2025-02-10T00:00:00Z",
    updated_at: "2025-03-10T00:00:00Z",
  },
  {
    id: "camp-003",
    client_id: "client-002",
    organization_id: MOCK_ORG.id,
    instantly_campaign_id: "inst_camp_ghi789",
    name: "TechStartup — CTO Outreach",
    status: "active",
    created_at: "2025-02-15T00:00:00Z",
    updated_at: "2025-03-15T00:00:00Z",
  },
  {
    id: "camp-004",
    client_id: "client-002",
    organization_id: MOCK_ORG.id,
    instantly_campaign_id: "inst_camp_jkl012",
    name: "TechStartup — VP Eng Warm-up",
    status: "paused",
    created_at: "2025-03-01T00:00:00Z",
    updated_at: "2025-03-12T00:00:00Z",
  },
];

// ---------- Snapshots (last 30 days of daily data) ----------
function generateSnapshots(): CampaignSnapshot[] {
  const snapshots: CampaignSnapshot[] = [];
  const activeCampaigns = ["camp-001", "camp-002", "camp-003"];

  for (const campId of activeCampaigns) {
    for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
      const date = new Date();
      date.setDate(date.getDate() - dayOffset);
      const dateStr = date.toISOString().split("T")[0];

      // Vary data per campaign
      const baseMultiplier = campId === "camp-001" ? 1.2 : campId === "camp-002" ? 0.8 : 1.0;
      const dailyVariation = 0.7 + Math.random() * 0.6; // 0.7 to 1.3

      const sent = Math.round(45 * baseMultiplier * dailyVariation);
      const replies = Math.round(sent * (0.04 + Math.random() * 0.04)); // 4-8% reply
      const uniqueReplies = Math.max(1, replies - Math.floor(Math.random() * 2));
      const positiveReplies = Math.round(uniqueReplies * (0.3 + Math.random() * 0.3));
      const bounces = Math.round(sent * (0.01 + Math.random() * 0.02));
      const unsubscribes = Math.random() > 0.8 ? 1 : 0;
      const meetings = Math.random() > 0.7 ? (Math.random() > 0.5 ? 2 : 1) : 0;

      snapshots.push({
        id: `snap-${campId}-${dateStr}`,
        campaign_id: campId,
        snapshot_date: dateStr,
        total_leads: Math.round(500 * baseMultiplier),
        emails_sent: sent,
        replies,
        unique_replies: uniqueReplies,
        positive_replies: positiveReplies,
        bounces,
        unsubscribes,
        meetings_booked: meetings,
        new_leads_contacted: Math.round(sent * 0.6),
        reply_rate: sent > 0 ? Number(((uniqueReplies / sent) * 100).toFixed(2)) : 0,
        positive_reply_rate: uniqueReplies > 0 ? Number(((positiveReplies / uniqueReplies) * 100).toFixed(2)) : 0,
        bounce_rate: sent > 0 ? Number(((bounces / sent) * 100).toFixed(2)) : 0,
        unsubscribe_rate: sent > 0 ? Number(((unsubscribes / sent) * 100).toFixed(2)) : 0,
        raw_data: null,
        fetched_at: new Date().toISOString(),
      });
    }
  }

  return snapshots;
}

export const MOCK_SNAPSHOTS: CampaignSnapshot[] = generateSnapshots();

// ---------- Feedback ----------
export const MOCK_FEEDBACK: LeadFeedback[] = [
  {
    id: "fb-001",
    campaign_id: "camp-001",
    lead_email: "mark.johnson@bigcorp.com",
    lead_name: "Mark Johnson",
    lead_company: "BigCorp Holdings",
    status: "good_lead",
    comment: "Responded positively, wants to schedule a call next week",
    submitted_by: "user-client-001",
    created_at: "2025-03-20T14:30:00Z",
  },
  {
    id: "fb-002",
    campaign_id: "camp-001",
    lead_email: "sarah.williams@realtyfund.com",
    lead_name: "Sarah Williams",
    lead_company: "Realty Fund LLC",
    status: "interested",
    comment: "Asked for more information about our services",
    submitted_by: "user-client-001",
    created_at: "2025-03-19T10:00:00Z",
  },
  {
    id: "fb-003",
    campaign_id: "camp-001",
    lead_email: "tom.davis@nocorp.com",
    lead_name: "Tom Davis",
    lead_company: "NoCorp Inc",
    status: "bad_lead",
    comment: "Wrong industry — they do residential only",
    submitted_by: "user-client-001",
    created_at: "2025-03-18T16:45:00Z",
  },
  {
    id: "fb-004",
    campaign_id: "camp-003",
    lead_email: "jennifer.lee@saasco.io",
    lead_name: "Jennifer Lee",
    lead_company: "SaaSCo",
    status: "good_lead",
    comment: "Great fit — already using competitor, wants demo",
    submitted_by: "user-client-002",
    created_at: "2025-03-21T09:15:00Z",
  },
  {
    id: "fb-005",
    campaign_id: "camp-003",
    lead_email: "alex.chen@devtools.com",
    lead_name: "Alex Chen",
    lead_company: "DevTools Inc",
    status: "already_contacted",
    comment: "We already spoke to them last month",
    submitted_by: "user-client-002",
    created_at: "2025-03-17T11:30:00Z",
  },
  {
    id: "fb-006",
    campaign_id: "camp-002",
    lead_email: "robert.kim@apartments.net",
    lead_name: "Robert Kim",
    lead_company: "Metro Apartments",
    status: "wrong_person",
    comment: "Not the decision maker — referred us to their VP",
    submitted_by: "user-client-001",
    created_at: "2025-03-16T13:00:00Z",
  },
  {
    id: "fb-007",
    campaign_id: "camp-003",
    lead_email: "diana.patel@cloudops.io",
    lead_name: "Diana Patel",
    lead_company: "CloudOps",
    status: "not_interested",
    comment: "Said they just signed a 2-year contract with someone else",
    submitted_by: "user-client-002",
    created_at: "2025-03-15T08:45:00Z",
  },
];

// ---------- Webhook Events ----------
export const MOCK_EVENTS: WebhookEvent[] = [
  {
    id: "evt-001",
    organization_id: MOCK_ORG.id,
    event_type: "email_replied",
    campaign_instantly_id: "inst_camp_abc123",
    lead_email: "mark.johnson@bigcorp.com",
    payload: { reply_type: "positive" },
    processed: true,
    excluded: false,
    received_at: "2025-03-23T10:30:00Z",
  },
  {
    id: "evt-002",
    organization_id: MOCK_ORG.id,
    event_type: "email_sent",
    campaign_instantly_id: "inst_camp_abc123",
    lead_email: "new.lead@prospect.com",
    payload: {},
    processed: true,
    excluded: false,
    received_at: "2025-03-23T09:15:00Z",
  },
  {
    id: "evt-003",
    organization_id: MOCK_ORG.id,
    event_type: "email_bounced",
    campaign_instantly_id: "inst_camp_ghi789",
    lead_email: "invalid@old-domain.com",
    payload: { bounce_type: "hard" },
    processed: true,
    excluded: false,
    received_at: "2025-03-22T22:00:00Z",
  },
  {
    id: "evt-004",
    organization_id: MOCK_ORG.id,
    event_type: "meeting_booked",
    campaign_instantly_id: "inst_camp_abc123",
    lead_email: "sarah.williams@realtyfund.com",
    payload: { meeting_date: "2025-03-28" },
    processed: true,
    excluded: false,
    received_at: "2025-03-22T15:45:00Z",
  },
  {
    id: "evt-005",
    organization_id: MOCK_ORG.id,
    event_type: "email_replied",
    campaign_instantly_id: "inst_camp_ghi789",
    lead_email: "jennifer.lee@saasco.io",
    payload: { reply_type: "positive" },
    processed: true,
    excluded: false,
    received_at: "2025-03-22T11:30:00Z",
  },
];

// ---------- KPI Reports ----------
export const MOCK_REPORTS: KPIReport[] = [
  {
    id: "report-001",
    client_id: "client-001",
    organization_id: MOCK_ORG.id,
    report_period_start: "2025-03-01",
    report_period_end: "2025-03-15",
    report_data: {
      client_name: "Acme Corp",
      period: { start: "2025-03-01", end: "2025-03-15" },
      campaigns: [
        {
          campaign_name: "Acme — Commercial RE Investors Q1",
          campaign_id: "camp-001",
          metrics: {
            emails_sent: 680,
            replies: 41,
            unique_replies: 38,
            positive_replies: 15,
            bounces: 12,
            unsubscribes: 2,
            meetings_booked: 6,
            reply_rate: 5.59,
            positive_reply_rate: 39.47,
            bounce_rate: 1.76,
            unsubscribe_rate: 0.29,
            reply_to_meeting_rate: 15.79,
          },
        },
      ],
      totals: {
        emails_sent: 680,
        replies: 41,
        unique_replies: 38,
        positive_replies: 15,
        bounces: 12,
        unsubscribes: 2,
        meetings_booked: 6,
        reply_rate: 5.59,
        positive_reply_rate: 39.47,
        bounce_rate: 1.76,
        unsubscribe_rate: 0.29,
        reply_to_meeting_rate: 15.79,
      },
    },
    sent_at: "2025-03-16T09:00:00Z",
    sent_to: ["john@acmecorp.com"],
    created_by: "user-owner-001",
    created_at: "2025-03-16T09:00:00Z",
  },
  {
    id: "report-002",
    client_id: "client-002",
    organization_id: MOCK_ORG.id,
    report_period_start: "2025-03-01",
    report_period_end: "2025-03-15",
    report_data: {
      client_name: "TechStartup Inc",
      period: { start: "2025-03-01", end: "2025-03-15" },
      campaigns: [
        {
          campaign_name: "TechStartup — CTO Outreach",
          campaign_id: "camp-003",
          metrics: {
            emails_sent: 540,
            replies: 35,
            unique_replies: 30,
            positive_replies: 12,
            bounces: 8,
            unsubscribes: 1,
            meetings_booked: 4,
            reply_rate: 5.56,
            positive_reply_rate: 40.0,
            bounce_rate: 1.48,
            unsubscribe_rate: 0.19,
            reply_to_meeting_rate: 13.33,
          },
        },
      ],
      totals: {
        emails_sent: 540,
        replies: 35,
        unique_replies: 30,
        positive_replies: 12,
        bounces: 8,
        unsubscribes: 1,
        meetings_booked: 4,
        reply_rate: 5.56,
        positive_reply_rate: 40.0,
        bounce_rate: 1.48,
        unsubscribe_rate: 0.19,
        reply_to_meeting_rate: 13.33,
      },
    },
    sent_at: null,
    sent_to: null,
    created_by: "user-owner-001",
    created_at: "2025-03-16T09:30:00Z",
  },
];

// ---------- Billing (Stripe placeholders) ----------
export interface BillingClient {
  clientId: string;
  clientName: string;
  plan: "starter" | "growth" | "scale";
  monthlyRate: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: "active" | "past_due" | "canceled" | "trialing";
  currentPeriodEnd: string;
  invoices: BillingInvoice[];
}

export interface BillingInvoice {
  id: string;
  date: string;
  amount: number;
  status: "paid" | "open" | "past_due" | "void";
  stripeInvoiceUrl: string | null;
}

export const BILLING_PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: 497,
    features: ["1 campaign", "Up to 500 leads/mo", "Weekly KPI reports", "Basic support"],
  },
  {
    id: "growth",
    name: "Growth",
    price: 997,
    features: [
      "3 campaigns",
      "Up to 2,000 leads/mo",
      "Daily KPI reports",
      "Priority support",
      "Client portal access",
    ],
  },
  {
    id: "scale",
    name: "Scale",
    price: 1997,
    features: [
      "Unlimited campaigns",
      "Unlimited leads",
      "Real-time reporting",
      "Dedicated account manager",
      "Custom integrations",
      "White-label portal",
    ],
  },
];

export const MOCK_BILLING: BillingClient[] = [
  {
    clientId: "client-001",
    clientName: "Acme Corp",
    plan: "growth",
    monthlyRate: 997,
    stripeCustomerId: "cus_demo_acme",
    stripeSubscriptionId: "sub_demo_acme",
    status: "active",
    currentPeriodEnd: "2025-04-15T00:00:00Z",
    invoices: [
      { id: "inv-001", date: "2025-03-15", amount: 997, status: "paid", stripeInvoiceUrl: null },
      { id: "inv-002", date: "2025-02-15", amount: 997, status: "paid", stripeInvoiceUrl: null },
      { id: "inv-003", date: "2025-01-15", amount: 997, status: "paid", stripeInvoiceUrl: null },
    ],
  },
  {
    clientId: "client-002",
    clientName: "TechStartup Inc",
    plan: "starter",
    monthlyRate: 497,
    stripeCustomerId: "cus_demo_techstartup",
    stripeSubscriptionId: "sub_demo_techstartup",
    status: "active",
    currentPeriodEnd: "2025-04-01T00:00:00Z",
    invoices: [
      { id: "inv-004", date: "2025-03-01", amount: 497, status: "paid", stripeInvoiceUrl: null },
      { id: "inv-005", date: "2025-02-01", amount: 497, status: "paid", stripeInvoiceUrl: null },
    ],
  },
  {
    clientId: "client-003",
    clientName: "GrowthCo Marketing",
    plan: "scale",
    monthlyRate: 1997,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: "trialing",
    currentPeriodEnd: "2025-04-15T00:00:00Z",
    invoices: [],
  },
];

// ---------- Step Metrics (for step-level health analysis) ----------
import type { CampaignStepMetric } from "@/types/app";

function generateStepMetrics(): CampaignStepMetric[] {
  const metrics: CampaignStepMetric[] = [];
  const campaigns = ["camp-001", "camp-002", "camp-003"];

  for (const campId of campaigns) {
    for (let step = 1; step <= 3; step++) {
      // Generate 4 weekly periods
      for (let weekOffset = 3; weekOffset >= 0; weekOffset--) {
        const end = new Date();
        end.setDate(end.getDate() - weekOffset * 7);
        const start = new Date(end);
        start.setDate(start.getDate() - 7);

        const baseSent = Math.round(40 + Math.random() * 30);
        // Step 1 has higher reply rate, drops for later steps
        const baseReplyRate = step === 1 ? 8 + Math.random() * 4 : step === 2 ? 4 + Math.random() * 3 : 2 + Math.random() * 2;

        // For camp-003, simulate a drop in step 1 reply rate in the latest period
        let replyRate = baseReplyRate;
        if (campId === "camp-003" && step === 1 && weekOffset === 0) {
          replyRate = 2.5; // Dropped from ~10% to 2.5%
        }

        const replies = Math.round(baseSent * (replyRate / 100));
        const opens = Math.round(baseSent * (0.3 + Math.random() * 0.2));
        const bounces = Math.round(baseSent * (0.01 + Math.random() * 0.02));

        metrics.push({
          id: `step-${campId}-s${step}-w${weekOffset}`,
          campaign_id: campId,
          step,
          period_start: start.toISOString().split("T")[0],
          period_end: end.toISOString().split("T")[0],
          sent: baseSent,
          replies,
          unique_replies: replies,
          opens,
          unique_opens: opens,
          bounces,
          reply_rate: Number(replyRate.toFixed(2)),
          open_rate: baseSent > 0 ? Number(((opens / baseSent) * 100).toFixed(2)) : 0,
          bounce_rate: baseSent > 0 ? Number(((bounces / baseSent) * 100).toFixed(2)) : 0,
          fetched_at: new Date().toISOString(),
        });
      }
    }
  }

  return metrics;
}

export const MOCK_STEP_METRICS: CampaignStepMetric[] = generateStepMetrics();

// ---------- Prospects / CRM ----------
export const MOCK_PROSPECTS: Prospect[] = [
  {
    id: "prospect-001",
    organization_id: MOCK_ORG.id,
    company_name: "BlueSky Roofing",
    contact_name: "James Walker",
    contact_email: "james@blueskyroofing.com",
    contact_phone: "(555) 234-5678",
    website: "blueskyroofing.com",
    industry: "Home Services",
    stage: "meeting",
    deal_notes: "Wants to target commercial property managers. Meeting Thursday 3pm.",
    follow_up_date: "2025-03-27",
    created_at: "2025-03-10T00:00:00Z",
    updated_at: "2025-03-22T00:00:00Z",
  },
  {
    id: "prospect-002",
    organization_id: MOCK_ORG.id,
    company_name: "Apex Financial Advisors",
    contact_name: "Rachel Kim",
    contact_email: "rachel@apexfa.com",
    contact_phone: "(555) 876-5432",
    website: "apexfa.com",
    industry: "Financial Services",
    stage: "proposal",
    deal_notes: "Sent Growth plan proposal ($997/mo). Waiting on decision. Targeting HNW individuals.",
    follow_up_date: "2025-03-25",
    created_at: "2025-03-05T00:00:00Z",
    updated_at: "2025-03-20T00:00:00Z",
  },
  {
    id: "prospect-003",
    organization_id: MOCK_ORG.id,
    company_name: "NovaTech Solutions",
    contact_name: "David Chen",
    contact_email: "david@novatech.io",
    contact_phone: null,
    website: "novatech.io",
    industry: "SaaS / Tech",
    stage: "contacted",
    deal_notes: "Reached out via LinkedIn. Interested in CTO outreach campaign.",
    follow_up_date: "2025-03-26",
    created_at: "2025-03-18T00:00:00Z",
    updated_at: "2025-03-18T00:00:00Z",
  },
  {
    id: "prospect-004",
    organization_id: MOCK_ORG.id,
    company_name: "Summit Legal Group",
    contact_name: "Patricia Morales",
    contact_email: "pmorales@summitlegal.com",
    contact_phone: "(555) 321-9876",
    website: "summitlegal.com",
    industry: "Legal",
    stage: "lead",
    deal_notes: "Referred by Acme Corp. Hasn't been contacted yet.",
    follow_up_date: null,
    created_at: "2025-03-21T00:00:00Z",
    updated_at: "2025-03-21T00:00:00Z",
  },
  {
    id: "prospect-005",
    organization_id: MOCK_ORG.id,
    company_name: "Greenfield Properties",
    contact_name: "Marcus Thompson",
    contact_email: "marcus@greenfieldprop.com",
    contact_phone: "(555) 654-3210",
    website: "greenfieldprop.com",
    industry: "Real Estate",
    stage: "closed",
    deal_notes: "Signed on Scale plan. Converted to client — see GrowthCo Marketing.",
    follow_up_date: null,
    created_at: "2025-02-15T00:00:00Z",
    updated_at: "2025-03-15T00:00:00Z",
  },
  {
    id: "prospect-006",
    organization_id: MOCK_ORG.id,
    company_name: "FastTrack Logistics",
    contact_name: "Amy Liu",
    contact_email: "amy@fasttracklog.com",
    contact_phone: null,
    website: "fasttracklog.com",
    industry: "Logistics",
    stage: "lost",
    deal_notes: "Went with a competitor. Budget was the main concern. Re-engage in Q3.",
    follow_up_date: "2025-07-01",
    created_at: "2025-02-01T00:00:00Z",
    updated_at: "2025-03-05T00:00:00Z",
  },
];
