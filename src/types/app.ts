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

// Per-mailbox inbox-health band (migration 00061). Parallels KPIHealth but
// named for the mailbox-health domain: healthy / watch / critical.
export type HealthBand = "healthy" | "watch" | "critical";

export interface Organization {
  id: string;
  name: string;
  scrapio_api_key: string | null;
  scrapio_credits_balance: number | null;
  scrapio_last_credit_check_at: string | null;
  // Decision-maker enrichment (migration 00044). Anthropic powers Layer 1
  // (website scrape via Haiku); Perplexity is the optional Layer 2
  // fallback (web search). Either may fall back to env vars at runtime.
  anthropic_api_key: string | null;
  perplexity_api_key: string | null;
  // Unipile (LinkedIn channel — migration 00046). DSN is the per-workspace
  // host Unipile assigns at signup (e.g. "api7.unipile.com:13779"). Webhook
  // ID is populated when commit #5 registers the messaging/account_status
  // webhooks; null until one-time setup runs.
  unipile_api_key: string | null;
  unipile_dsn: string | null;
  unipile_webhook_id: string | null;
  // Native email channel (migration 00056). A Google service account with
  // domain-wide delegation; the key impersonates any mailbox on an
  // authorized domain. Same trust boundary as the other org-level keys.
  gmail_service_account_email: string | null;
  gmail_service_account_key: string | null;
  // Instantly (email channel — re-added migration 00065). Campaigns are
  // authored + sent inside Instantly; LeadStart links to them via the API
  // key, pushes leads, ingests replies (webhook id set once the reply webhook
  // is registered), and rolls up analytics. workspace_id is stored for
  // reference/scoping; null until one-time setup runs.
  instantly_api_key: string | null;
  instantly_workspace_id: string | null;
  instantly_webhook_id: string | null;
  // Inbox-placement testing (migration 00068). Days between automatic
  // neutral probes per active mailbox; NULL = manual runs only.
  placement_test_interval_days: number | null;
  // Email verification — Million Verifier (migration 00069). API key (NULL
  // disarms the pre-send gate). credits + checked_at are the last-seen balance;
  // the error trio drives 1h call-suppression after a definitive account error
  // (bad key / no credits / IP blocked) and the edge-triggered owner alert.
  millionverifier_api_key: string | null;
  millionverifier_credits: number | null;
  millionverifier_credits_checked_at: string | null;
  millionverifier_last_error: string | null;
  millionverifier_last_error_kind: "auth" | "credits" | "blocked" | "transient" | null;
  millionverifier_last_error_at: string | null;
  millionverifier_error_streak: number;
  // Apify token (migration 00070). One key powers the Contacts → Enrich
  // phases: LinkedIn profile → email, company → domain, and the second-pass
  // email waterfall. Falls back to process.env.APIFY_API_TOKEN at runtime.
  // (Email verification is Million Verifier's, above — not Apify's.)
  apify_api_key: string | null;
  // Configurable enrichment waterfall (migration 00075). NULL → code defaults
  // (DEFAULT_ENRICHMENT_SETTINGS). Read/merged via loadEnrichmentSettings.
  enrichment_settings: EnrichmentSettings | null;
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
  receives_contact_notifications: boolean;
  created_at: string;
  updated_at: string;
}

export type ClientStatus = "active" | "former";

export type ReportFrequency = "weekly" | "biweekly" | "monthly";

export interface Client {
  id: string;
  organization_id: string;
  name: string;
  contact_email: string | null;
  notes: string | null;
  // Fixed day/time schedule (migration 00040) — preferred
  report_frequency: ReportFrequency | null;
  report_day_of_week: number | null;   // 0-6, Sunday=0 (weekly/biweekly)
  report_day_of_month: number | null;  // 1-28 or -1 for "last day" (monthly)
  report_time_of_day: string | null;   // 'HH:MM' 24h, evaluated in report_timezone
  report_timezone: string | null;      // IANA tz (e.g., America/New_York)
  // Legacy elapsed-time schedule — retained for back-compat, not read by cron
  report_interval_days: number | null;
  report_schedule_start: string | null;
  report_last_sent_at: string | null;
  report_recipients: string[] | null;
  stripe_customer_id: string | null;
  status: ClientStatus;
  // True for the pseudo-client representing this organization's own internal
  // marketing outreach (migration 00048). Excluded from billing/MRR; pinned
  // in the campaign-linking picker. At most one per organization.
  is_internal: boolean;
  // Reply routing pipeline (migration 00025) — populated during onboarding
  notification_email: string | null;     // single address for hot-reply notifications
  notification_cc_emails: string[];       // extra teammates CC'd on notifications + portal sends (migration 00030)
  phone_number: string | null;            // for display in the dossier
  auto_notify_classes: ReplyClass[];      // default: hot classes only
  persona_name: string | null;            // real person on alias domain (Path 1)
  persona_title: string | null;
  persona_linkedin_url: string | null;
  persona_photo_url: string | null;
  brand_voice: string | null;
  signature_block: string | null;
  // LinkedIn channel (migration 00046). Populated by the hosted-auth
  // connect flow; status flips to 'expired' on Unipile's
  // account_disconnected webhook (handled in commit #5).
  unipile_account_id: string | null;
  unipile_account_status: "disconnected" | "connected" | "expired" | null;
  created_at: string;
  updated_at: string;
}

export interface ClientUser {
  client_id: string;
  user_id: string;
  created_at: string;
  invite_status: string;
}

// How a native campaign spends its fixed daily send budget between brand-new
// first-touches and follow-ups (migration 00066). 'finish_first' (default)
// prioritizes follow-ups + throttles new leads by daily_new_leads_cap;
// 'reach_first' prioritizes new first-touches and lets them use full warmed
// inbox capacity. Resolved against DEFAULT_SENDING_STRATEGY in src/lib/gmail/ramp.ts.
export type SendingStrategy = "finish_first" | "reach_first";

export interface Campaign {
  id: string;
  // NULL for "orphan" campaigns — rows imported by the discovery cron
  // before an owner has linked them to a LeadStart client. Existing admin
  // surfaces filter or degrade gracefully when client_id is NULL.
  client_id: string | null;
  organization_id: string;
  // User-chosen CSV header → LeadStart field mapping, persisted per
  // campaign so re-uploads pre-populate the mapping UI (migration 00055).
  csv_column_mapping: Record<string, string> | null;
  name: string;
  status: CampaignStatus;
  // Channel discriminator. 'native_email' for the Gmail-API email channel;
  // 'linkedin' for Unipile-driven sequences; 'instantly' for campaigns
  // authored + sent inside Instantly (LeadStart links + pushes leads).
  source_channel: SourceChannel;
  // Per-campaign native-email send window (migration 00058). NULL on any
  // field = inherit the global default (Mon–Fri 8am–5pm America/New_York).
  send_timezone: string | null;
  send_start_hour: number | null;
  send_end_hour: number | null;
  send_weekdays_only: boolean | null;
  // Per-campaign cap on new leads (step-0 first-touches) started per day
  // (migration 00064). NULL = inherit DEFAULT_DAILY_NEW_LEADS_CAP; 0 pauses new
  // leads while follow-ups keep flowing. Follow-ups are never limited by this.
  daily_new_leads_cap: number | null;
  // How the send worker allocates the day's budget between new first-touches and
  // follow-ups (migration 00066). NULL = inherit DEFAULT_SENDING_STRATEGY
  // ('finish_first'). See SendingStrategy above.
  sending_strategy: SendingStrategy | null;
  // Per-campaign Unipile account binding (migration 00046). Defaults to
  // clients.unipile_account_id but lives on the campaign so accounts can
  // rotate without invalidating campaign history.
  unipile_account_id: string | null;
  // Instantly campaign id (re-added migration 00065). Set for
  // source_channel='instantly' campaigns; links a LeadStart campaign to the
  // Instantly campaign it mirrors, for reply routing + analytics roll-up.
  instantly_campaign_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Sequence engine (migration 00047) ----------

export type SequenceStepKind =
  | "connect_request"
  | "message"
  | "inmail"
  | "like_post"
  | "profile_visit"
  // Native email channel (migration 00056). An email step carries a
  // subject_template on step 0; body_template holds the email body.
  | "email";

export type EnrollmentStatus =
  | "active"
  | "paused"
  | "completed"
  | "replied"
  | "failed";

// One row per step in a campaign's sequence template. step_index orders
// the steps; wait_days is days to wait AFTER the previous step's
// last_action_at before this one fires.
export interface CampaignStep {
  id: string;
  campaign_id: string;
  step_index: number;
  kind: SequenceStepKind;
  wait_days: number;
  body_template: string | null;
  // Email subject (migration 00056). Required on step 0 of an email
  // sequence; NULL on later steps means "Re: <step-0 subject>" (same thread).
  subject_template: string | null;
  conditions: Record<string, unknown> | null;
  created_at: string;
}

// Per-contact progress through a sequence. The cron worker
// /api/cron/run-linkedin-sequences advances active enrollments whose
// last_action_at + current step's wait_days has elapsed. unipile_chat_id
// is populated after the first message step opens a chat (or after a
// connect_request is accepted and the recipient replies).
export interface CampaignEnrollment {
  id: string;
  campaign_id: string;
  contact_id: string;
  current_step_index: number;
  last_action_at: string | null;
  status: EnrollmentStatus;
  started_at: string;
  unipile_chat_id: string | null;
  unipile_invitation_id: string | null;
  // Native email channel (migration 00056). native_mailbox_id is sticky:
  // the mailbox chosen at step 0 sends every follow-up so the thread and
  // SPF alignment stay consistent. gmail_thread_id + last_rfc_message_id
  // carry the threading state for follow-up steps.
  native_mailbox_id: string | null;
  gmail_thread_id: string | null;
  last_rfc_message_id: string | null;
  last_error: string | null;
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
  /** Resend message id captured on send; populated for rows sent after migration 00041. */
  resend_email_id: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  /** 'bounce' | 'complaint' | null. Set by /api/webhooks/resend. */
  bounce_type: string | null;
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
  new_leads_contacted: number;
  reply_rate: number;
  positive_reply_rate: number;
  bounce_rate: number;
  unsubscribe_rate: number;
  reply_to_meeting_rate: number;
}

// Step-level campaign metrics (per-step analytics from the upstream provider)
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

// CRM / Pipeline stages — pipeline state lives on `contacts` (no separate prospects table).
// A contact is "in the pipeline" when pipeline_stage is non-null.
export type ProspectStage = "lead" | "contacted" | "meeting" | "proposal" | "closed" | "lost";

export interface WebhookEvent {
  id: string;
  organization_id: string;
  event_type: string;
  lead_email: string | null;
  payload: Record<string, unknown>;
  processed: boolean;
  excluded: boolean;
  received_at: string;
  // Channel discriminator (migration 00045). Splits the audit log by
  // channel so the Events page can filter native-email vs LinkedIn traffic.
  source_channel: SourceChannel;
}

// Contacts (campaign leads)
export type ContactStatus = "new" | "enriched" | "queued" | "uploaded" | "active" | "bounced" | "replied" | "unsubscribed";

// Million Verifier per-address verdict (migration 00069). Orthogonal to
// ContactStatus. resultcode mapping: 1 ok, 2 catch_all, 3 unknown, 4 error,
// 5 disposable, 6 invalid.
export type EmailVerificationStatus =
  | "ok"
  | "catch_all"
  | "unknown"
  | "invalid"
  | "disposable"
  | "error";
export type EmailVerificationQuality = "good" | "bad" | "risky";

// Which method supplied the email during enrichment (migration 00070; waterfall
// methods extended in 00075). Provenance only — verification itself is Million
// Verifier's, not Apify's. `pattern_mv` (pattern-permutation + Million Verifier)
// and `site_scrape` (our own contact scraper) are the waterfall methods; `bovi`
// is the pay-per-found Apify fallback. (Historical rows may carry the retired
// `vdrmota` value in the plain-TEXT column — that's fine, it's provenance data.)
export type EmailProviderId =
  | "harvestapi"
  | "bovi"
  | "pattern_mv"
  | "site_scrape"
  // A personal email found by the decision-maker (naming) phase's Layer 1/2.
  | "decision_maker";

export interface Contact {
  id: string;
  organization_id: string;
  client_id: string | null;
  campaign_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  // Company-level contact info (migration 00076) — kept SEPARATE from the
  // decision-maker's own email/phone above. Filled by site scrape + the
  // harvestapi company actor (the company's main line / generic info@ inbox).
  company_phone: string | null;
  company_email: string | null;
  // The PERSON's location (migration 00078): LinkedIn profile location for
  // LinkedIn-sourced contacts, city/state for Scrap.io. NOT the company address
  // (that lives in enrichment_data.enrichment.company.hq when known).
  location: string | null;
  linkedin_url: string | null;
  // LinkedIn import + Apify enrichment (migration 00070). Email verification
  // itself lives in the Million Verifier fields below (single source of truth);
  // enrichment only fills `email` + provenance in enrichment_data/tags.
  company_linkedin_url: string | null;
  company_domain: string | null;
  // LinkedIn activity recency (Apify enrichment activity phase).
  last_posted_at: string | null;
  recent_post_count: number | null;
  activity_checked_at: string | null;
  intro_line: string | null;
  enrichment_data: Record<string, unknown>;
  // Arbitrary per-contact merge variables for sequence copy (e.g.
  // PropertyAddress, SoldDate). The CSV importer drops any non-standard
  // column here; the native sender resolves {{tokens}} against it.
  custom_fields: Record<string, unknown>;
  tags: string[];
  status: ContactStatus;
  source: string | null;
  notes: string | null;
  // Pipeline state — null means "not in the pipeline"
  pipeline_stage: ProspectStage | null;
  pipeline_sort_order: number;
  pipeline_notes: string | null;
  pipeline_follow_up_date: string | null;
  pipeline_added_at: string | null;
  // Email verification (migration 00069). Cached Million Verifier result for
  // `email`, written just before the first send and reused by follow-ups for
  // 30 days (email_verified_at drives the TTL). attempts bounds the retry loop
  // for indeterminate results (unknown / per-address error).
  email_verification_status: EmailVerificationStatus | null;
  email_verification_subresult: string | null;
  email_verification_quality: EmailVerificationQuality | null;
  email_is_free: boolean | null;
  email_is_role: boolean | null;
  email_did_you_mean: string | null;
  email_verified_at: string | null;
  email_verification_attempts: number;
  // NOT real columns — scalars projected out of enrichment_data by the list
  // fetchers (admin-queries CONTACT_LIST_COLUMNS, enrich/run/[id] join) so list
  // UIs can tier/badge emails without hauling the whole JSONB blob. Absent on
  // fetches that don't project them.
  email_kind?: string | null; // enrichment.email.kind — 'company_generic' for a backfilled inbox
  email_provider_status?: string | null; // enrichment.email.provider_status — 'catch_all' for an unprovable guess
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

// ---------- Billing ----------
export interface PricingPlan {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string | null;
  features: string[];
  monthly_price_cents: number;
  currency: string;
  stripe_product_id: string | null;
  stripe_monthly_price_id: string | null;
  scope_template: string | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired"
  | "canceled";

export interface Quote {
  id: string;
  organization_id: string;
  client_id: string;
  quote_number: string;
  plan_id: string | null;
  plan_name_snapshot: string | null;
  monthly_price_cents: number;
  setup_fee_cents: number;
  currency: string;
  scope_of_work: string | null;
  terms: string | null;
  signed_url_hash: string;
  status: QuoteStatus;
  expires_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  sent_to_email: string | null;
  sent_by: string | null;
  accepted_by_email: string | null;
  accepted_ip: string | null;
  accepted_user_agent: string | null;
  stripe_checkout_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "paused";

export interface ClientSubscription {
  id: string;
  organization_id: string;
  client_id: string;
  plan_id: string | null;
  quote_id: string | null;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  trial_end: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  setup_fee_cents: number | null;
  setup_fee_paid_at: string | null;
  warming_days_at_signup: number;
  created_at: string;
  updated_at: string;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "uncollectible" | "void";

export interface BillingInvoice {
  id: string; // Stripe invoice id (in_...)
  organization_id: string;
  client_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_invoice_number: string | null;
  amount_cents: number;
  amount_paid_cents: number;
  amount_due_cents: number;
  currency: string;
  status: InvoiceStatus;
  period_start: string | null;
  period_end: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  issued_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PaymentLinkStatus = "pending" | "completed" | "expired" | "canceled";

export interface PaymentLink {
  id: string;
  organization_id: string;
  client_id: string;
  quote_id: string | null;
  stripe_checkout_session_id: string;
  stripe_checkout_url: string | null;
  status: PaymentLinkStatus;
  created_at: string;
  expires_at: string | null;
  completed_at: string | null;
}

// ---------- Reply routing pipeline (migration 00025) ----------

export type ReplyStatus =
  | "new"                 // ingested, classifier hasn't run yet
  | "classified"          // classifier ran, waiting for client action (hot classes only)
  | "sent"                // client sent email reply via portal
  | "resolved"            // client handled offline (phone call, etc.)
  | "rejected"            // client explicitly dismissed
  | "expired"             // auto-expired after 48h of no action
  | "pending_enrichment"  // webhook's getEmail call failed; retry cron will attempt enrichment
  | "enrichment_failed";  // enrichment retries exhausted — terminal state, no auto-processing

// Classifier output. Matches final_class text column. See plan taxonomy.
export type ReplyClass =
  | "true_interest"
  | "meeting_booked"
  | "qualifying_question"
  | "objection_price"
  | "objection_timing"
  | "referral_forward"
  | "wrong_person_no_referral"
  | "ooo"
  | "not_interested"
  | "unsubscribe"
  | "needs_review";

export type ReplyOutcome =
  | "called"
  | "emailed"
  | "no_contact";

export interface ReplyReferralContact {
  email: string | null;          // null when a name was given but no email address
  name: string | null;
  title: string | null;
}

export type SourceChannel = "instantly" | "linkedin" | "native_email";

export interface LeadReply {
  id: string;
  organization_id: string;
  // NULL for orphan replies — replies captured by the webhook handler
  // when the campaign wasn't yet linked to a LeadStart client. The
  // classifier still runs; notification is skipped until B3 links the
  // campaign and a follow-up UPDATE populates client_id.
  client_id: string | null;
  campaign_id: string | null;
  // Channel discriminator (migration 00045). 'native_email' for Gmail-API
  // email replies; 'linkedin' for inbound DMs ingested by the Unipile webhook;
  // 'instantly' for replies ingested by the Instantly webhook.
  source_channel: SourceChannel;

  // Unipile references (migration 00046). Populated for LinkedIn DMs.
  // unipile_message_id is org-scoped unique for webhook dedup;
  // unipile_chat_id threads messages within a chat.
  unipile_message_id: string | null;
  unipile_chat_id: string | null;
  // Native email references (migration 00056). Populated for
  // source_channel='native_email' rows. gmail_message_id is org-scoped
  // unique for poller dedup; native_mailbox_id routes the outbound reply
  // back through the mailbox that received it.
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  native_mailbox_id: string | null;
  // Instantly references (re-added migration 00065). Populated for
  // source_channel='instantly' replies. instantly_email_id is Instantly's
  // Email-object UUID — org-scoped unique for webhook dedup, and the
  // reply_to_uuid when sending a reply back through /emails/reply.
  // instantly_eaccount is the hosted mailbox that received the reply (passed
  // back as `eaccount` on send); message/thread ids thread the conversation.
  instantly_email_id: string | null;
  instantly_message_id: string | null;
  instantly_eaccount: string | null;
  instantly_thread_id: string | null;

  // Lead identity
  lead_email: string;
  lead_name: string | null;
  lead_company: string | null;
  lead_title: string | null;
  lead_phone_e164: string | null;
  lead_linkedin_url: string | null;

  // Reply content
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string;
  raw_payload: Record<string, unknown> | null;

  // Classification
  keyword_flags: string[];
  claude_class: ReplyClass | null;
  claude_confidence: number | null;
  claude_reason: string | null;
  referral_contact: ReplyReferralContact | null;
  final_class: ReplyClass | null;
  classified_at: string | null;

  // Notification
  notified_at: string | null;
  notification_token_hash: string | null;
  notification_token_consumed_at: string | null;
  notification_email_id: string | null;
  // Notification reliability (migration 00032) — retry-queue state
  notification_status: "pending" | "sent" | "failed" | "retrying";
  notification_retry_count: number;
  notification_last_attempt_at: string | null;
  notification_last_error: string | null;
  notification_delivered_at: string | null;
  notification_bounced_at: string | null;
  // Enrichment retry (migration 00037) — populated when webhook's getEmail
  // fails and the row is parked as status='pending_enrichment'.
  enrichment_retry_count: number;
  enrichment_last_attempt_at: string | null;

  // Outcome
  outcome: ReplyOutcome | null;
  outcome_notes: string | null;
  outcome_logged_at: string | null;
  outcome_logged_by: string | null;

  // Reclassify audit (populated by POST /api/replies/[id]/reclassify, migration 00028)
  reclassified_by: string | null;
  reclassified_at: string | null;
  reclassified_from: ReplyClass | null;

  // Exclude this reply/lead from the client's stats (migration 00060). The
  // native analytics roll-up skips excluded rows when recomputing snapshots.
  excluded_from_stats: boolean;
  excluded_at: string | null;
  excluded_by: string | null;

  // Send (manual reply composed by the client via /api/replies/[id]/send)
  status: ReplyStatus;
  final_body_text: string | null;
  final_body_html: string | null;
  sent_at: string | null;
  // Outbound provider id (the Gmail message id, etc.) returned from the
  // reply-send call. Was named sent_instantly_email_id pre-migration 00051.
  sent_external_email_id: string | null;
  error: string | null;
  // D2 idempotency tombstone — sha256(reply.id + body_text).slice(0, 16).
  // Stamped on atomic claim; persists through error rollbacks.
  idempotency_key: string | null;

  created_at: string;
  updated_at: string;
}

// ---------- Native email channel (migration 00056) ----------

export type NativeMailboxStatus = "active" | "paused" | "error";

// A client-owned Google Workspace sending inbox. LeadStart sends through it
// via the Gmail API (service account + domain-wide delegation). The ramp
// fields drive per-inbox pacing (see src/lib/gmail/ramp.ts).
export interface NativeMailbox {
  id: string;
  organization_id: string;
  client_id: string | null;
  email_address: string;
  display_name: string | null;
  provider: "gmail";
  status: NativeMailboxStatus;
  ramp_started_at: string;        // 'YYYY-MM-DD'
  max_daily_cap: number;
  daily_cap_override: number | null;
  last_error: string | null;
  last_error_at: string | null;
  last_polled_at: string | null;
  // Inbox-health scoring (migration 00061). Denormalized "current" values,
  // refreshed by /api/cron/check-inbox-health. Null until the first check.
  // health_paused_at is set only when the health check auto-pauses the mailbox
  // (cleared on manual resume), so an automatic bench reads distinctly from a
  // manual pause.
  health_score: number | null;
  health_band: HealthBand | null;
  health_components: HealthComponent[] | null;
  health_checked_at: string | null;
  health_paused_at: string | null;
  created_at: string;
  updated_at: string;
}

export type NativeSendStatus = "sent" | "bounced";

// One inbox-health snapshot (migration 00061). Inserted only when a mailbox's
// score changes or an action is taken, so the table is a transition timeline.
// `components` is the per-signal breakdown the admin UI renders.
export interface MailboxHealthCheck {
  id: string;
  organization_id: string;
  mailbox_id: string;
  checked_at: string;
  score: number;
  band: HealthBand;
  components: HealthComponent[];
  action: string | null;
}

// A single scored signal inside a health check. The scorer
// (src/lib/deliverability/inbox-health.ts) imports this type and produces
// these; they persist verbatim into mailbox_health_checks.components.
export type HealthComponentStatus = "ok" | "warn" | "bad" | "unchecked";
export interface HealthComponent {
  key:
    | "blacklist"
    | "spf"
    | "dkim"
    | "dmarc"
    | "mx"
    | "bounce_rate"
    | "soft_bounce_rate"
    | "reply_signal"
    | "seed_placement"
    | "heat_score"
    | "warmup_placement";
  label: string;
  status: HealthComponentStatus;
  deduction: number;
  detail: string;
}

// ---------- Seed inboxes + placement tests (migration 00068) ----------

export type SeedInboxStatus = "active" | "paused" | "error";

// A Google Workspace inbox we control on a DWD-authorized domain. Sending
// mailboxes probe it; the placement checker reads it (gmail.readonly) to see
// where the probe landed. v1 is Workspace-only; the provider column reserves
// room for IMAP / Microsoft Graph seeds later.
export interface SeedInbox {
  id: string;
  organization_id: string;
  email_address: string;
  label: string | null;
  provider: "google_workspace";
  status: SeedInboxStatus;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

// What a placement test sends: a neutral, realistic note (reputation + auth in
// isolation) or the first step of the campaign this mailbox is pooled into,
// rendered with sample merge values (the real copy).
export type PlacementProbe = "neutral" | "campaign";
export type PlacementTestStatus = "sending" | "awaiting" | "complete" | "failed";
export type PlacementResultStatus =
  | "pending"
  | "inbox"
  | "promotions"
  | "spam"
  | "other"
  | "missing"
  | "bounced"
  | "send_failed"
  | "unreadable";

// SPF/DKIM/DMARC verdicts as the RECEIVING side reported them in the probe's
// Authentication-Results header — the authoritative answer to "did auth pass
// on delivery", as opposed to our own DNS checks of what's published.
export interface PlacementAuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  raw: string | null;
}

export interface PlacementAuthSummary {
  checked: number;
  spf_fail: number;
  dkim_fail: number;
  dmarc_fail: number;
}

// One probe run per sending mailbox. Counts are denormalized at completion
// (src/lib/deliverability/placement-runner.ts) so the mailboxes list and the
// health cron read them without joining results.
export interface PlacementTest {
  id: string;
  organization_id: string;
  mailbox_id: string;
  probe: PlacementProbe;
  campaign_id: string | null;
  triggered_by: "manual" | "scheduled";
  status: PlacementTestStatus;
  subject: string | null;
  seeds_total: number;
  inbox_count: number;
  promotions_count: number;
  spam_count: number;
  missing_count: number;
  auth_summary: PlacementAuthSummary | null;
  error: string | null;
  started_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

// One seed's outcome inside a run. labels = the raw Gmail labelIds seen in
// the seed (INBOX, CATEGORY_PROMOTIONS, SPAM, ...).
export interface PlacementTestResult {
  id: string;
  test_id: string;
  seed_inbox_id: string | null;
  seed_email: string;
  rfc_message_id: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  status: PlacementResultStatus;
  labels: string[] | null;
  auth_results: PlacementAuthResults | null;
  detail: string | null;
  sent_at: string | null;
  found_at: string | null;
  checked_at: string | null;
}

// Append-only send log — one row per successful send. Doubles as the
// per-mailbox daily-cap counter, the sent/bounced metric source, and the
// reply-thread match index.
export interface NativeSend {
  id: string;
  organization_id: string;
  campaign_id: string;
  contact_id: string;
  enrollment_id: string | null;
  mailbox_id: string;
  step_index: number;
  to_email: string;
  rfc_message_id: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  status: NativeSendStatus;
  bounce_reason: string | null;
  sent_at: string;
  bounced_at: string | null;
  // Soft (4.x.x, transient) bounce timestamp (migration 00067). Does NOT change
  // status — soft bounces aren't suppressed — but feeds the inbox-health
  // soft-bounce signal. Null = no soft bounce observed for this send.
  soft_bounced_at: string | null;
  // What the pre-send verification gate saw at send time (migration 00069).
  // Null = the gate was disarmed (no Million Verifier key) when this row wrote.
  email_verification_result: "ok" | "catch_all" | "unknown" | null;
}

// Classes that trigger client notification by default.
export const HOT_REPLY_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "referral_forward",
];

// Prospecting (Scrap.io lead enrichment)

// Flattened business row stored in prospect_searches.results and shown in
// the Prospecting table. Mirrors what the Replit reference build emitted —
// purposely matches the shape of contacts (name, email, phone, etc.) so
// the save-to-contacts mapping stays one-to-one.
export interface ScrapioBusiness {
  name: string;
  google_id: string;
  types: string;
  website: string;
  email: string;
  phone: string;
  phone_international: string;
  full_address: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  latitude: string | number;
  longitude: string | number;
  reviews_count: number;
  reviews_rating: string | number;
  is_closed: boolean;
  link: string;
  facebook: string;
  instagram: string;
  linkedin: string;
  twitter: string;
  youtube: string;
}

export type ProspectSearchStatus = "pending" | "running" | "complete" | "failed";

// Cached search audit row. Lives 30 days, then expires_at is the cron's
// cleanup signal. Status fields drive the background worker (see
// /api/cron/run-prospect-searches) and the polling UX on the page.
export interface ProspectSearch {
  id: string;
  organization_id: string;
  created_by: string;
  query: Record<string, unknown>;
  results: ScrapioBusiness[];
  result_count: number;
  pages_fetched: number;
  truncated: boolean;
  saved_count: number;
  status: ProspectSearchStatus;
  started_at: string | null;
  completed_at: string | null;
  progress_message: string | null;
  error_message: string | null;
  next_cursor: string | null;
  target_max_results: number;
  expires_at: string;
  created_at: string;
}

// ---------- LinkedIn people-search sourcing (migration 00072) ----------

export type LinkedInSearchStatus = "pending" | "running" | "complete" | "failed";

// One sourced person, flattened from the linkedin-profile-search actor.
// linkedin_url is the identity/dedupe key (like ScrapioBusiness.google_id).
export interface LinkedInProspect {
  profile_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  headline: string | null;
  linkedin_url: string | null;
  location: string | null;
  company_name: string | null;
  company_linkedin_url: string | null;
  company_domain: string | null;
  email: string | null;
}

// Cached people-search audit row + async Apify run tracking. The background
// worker (/api/cron/run-linkedin-searches) starts the actor and polls it across
// ticks; the page polls this row for progress. Mirrors ProspectSearch but the
// engine is an async Apify actor rather than a synchronous cursor API.
export interface LinkedInSearch {
  id: string;
  organization_id: string;
  created_by: string;
  query: Record<string, unknown>;
  results: LinkedInProspect[];
  result_count: number;
  target_max_results: number;
  truncated: boolean;
  saved_count: number;
  status: LinkedInSearchStatus;
  progress_message: string | null;
  error_message: string | null;
  actor: string;
  active_apify_run_id: string | null;
  active_apify_dataset_id: string | null;
  consecutive_failures: number;
  cost_usd: number | string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  created_at: string;
}

// ---------- Google Maps business-search sourcing (migration 00078) ----------

export type MapsSearchStatus = "pending" | "running" | "complete" | "failed";

// One place, flattened from the compass~google-maps-extractor actor.
// google_place_id is the identity/dedupe key (like LinkedInProspect.linkedin_url
// and ScrapioBusiness.google_id). company_domain is derived from `website` via
// normalizeDomain (null when the place has no site or only a social page).
export interface MapsPlace {
  google_place_id: string;
  name: string | null;
  category: string | null; // primary categoryName, kebab-slugged for DM seniority maps
  category_label: string | null; // human-readable categoryName as returned
  categories: string[];
  website: string | null;
  company_domain: string | null;
  phone: string | null; // E.164 preferred (phoneUnformatted)
  full_address: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null; // totalScore
  reviews_count: number | null;
  maps_url: string | null;
  temporarily_closed: boolean;
  claimed: boolean | null;
}

// Cached Maps-search audit row + async Apify run tracking — the Google-Maps twin
// of LinkedInSearch. The background worker (/api/cron/run-maps-searches) starts
// the compass actor and polls it across ticks; the page polls this row for
// progress. delivered_counts is the outcome ledger (Phase 5).
export interface MapsSearch {
  id: string;
  organization_id: string;
  created_by: string;
  query: Record<string, unknown>;
  results: MapsPlace[];
  result_count: number;
  target_max_results: number;
  truncated: boolean;
  saved_count: number;
  status: MapsSearchStatus;
  progress_message: string | null;
  error_message: string | null;
  actor: string;
  active_apify_run_id: string | null;
  active_apify_dataset_id: string | null;
  consecutive_failures: number;
  cost_usd: number | string;
  delivered_counts: Record<string, number>;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  created_at: string;
}

// ---------- Decision-maker enrichment (migration 00044) ----------

export type DmRunStatus = "pending" | "running" | "complete" | "failed";
export type DmServiceType = "operations" | "events";
export type DmResultStatus = "pending" | "complete" | "error" | "skipped";

// Parent run row — one created per "Find decision makers" click. The cron
// worker /api/cron/run-decision-maker-enrichment processes the children.
export interface DecisionMakerRun {
  id: string;
  organization_id: string;
  created_by: string;
  search_id: string;
  service_type: DmServiceType;
  use_layer2: boolean;
  status: DmRunStatus;
  total_count: number;
  processed_count: number;
  cost_usd: number | string;
  started_at: string | null;
  completed_at: string | null;
  progress_message: string | null;
  error_message: string | null;
  created_at: string;
}

// Per-business enrichment result. UNIQUE (search_id, google_id) lets a
// re-run reuse a prior result and lets the save endpoint merge enrichment
// onto the contact insert by (search, google_id).
export interface DecisionMakerResult {
  id: string;
  run_id: string;
  organization_id: string;
  search_id: string;
  google_id: string;
  business_name: string | null;
  category: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  personal_email: string | null;
  other_emails: string[];
  enrichment_source: "website" | "web_search" | null;
  enrichment_notes: string | null;
  status: DmResultStatus;
  cost_usd: number | string;
  created_at: string;
  updated_at: string;
}

// ---------- Contact enrichment runs (Apify: profiles → domains → waterfall → activity → verify) ----------
// Contact-keyed cousin of DecisionMakerRun/Result. Processed by
// /api/cron/run-apify-enrichment. See migration 00070.
//
// The core waterfall (profiles → domains → waterfall) always runs; `activity`
// and `verify` are OPT-IN add-ons (migration 00077, run_activity / run_verify).
// The `verify` phase is Million Verifier run inline on every found email so the
// enrichment report carries a verification verdict — MV stays the single source
// of truth; its pre-send gate is the backstop (and hits the 30-day cache, so no
// double spend). A run with verify off writes no verification columns here.

export type EnrichmentRunStatus = "pending" | "running" | "complete" | "failed";
export type EnrichmentPhase =
  | "profiles"
  | "domains"
  | "naming"
  | "waterfall"
  | "activity"
  | "verify"
  | "complete";
export type EnrichmentStepStatus =
  | "pending" | "in_flight" | "found" | "not_found" | "skipped" | "error";

// The pluggable second-pass email waterfall methods (migration 00075):
//   pattern_mv          — first/last/domain permutations verified by Million Verifier (default)
//   scrape_plus_pattern — our site scraper, then pattern_mv on the still-missing
//   site_scrape         — our own 5-tier anti-bot company-site scraper
//   bovi                — pay-per-found Apify pattern finder (fallback)
//   off                 — skip the waterfall for this size band
export type EnrichmentWaterfallMethod =
  | "scrape_plus_pattern"
  | "pattern_mv"
  | "site_scrape"
  | "bovi"
  | "off";

export const ENRICHMENT_WATERFALL_METHODS: readonly EnrichmentWaterfallMethod[] = [
  "scrape_plus_pattern",
  "pattern_mv",
  "site_scrape",
  "bovi",
  "off",
];

// The two opt-in add-on stages a prospecting search can bolt onto the core
// pipeline (chosen per-search, stamped on each imported contact's
// enrichment_data, then read back by enqueueEnrichment). Both default OFF — a
// missing/partial stamp coerces to false. See normalizeAddons in lib/apify/auth.
export interface EnrichmentAddons {
  // Score LinkedIn posting recency (harvestapi profile-posts).
  activity: boolean;
  // Verify every found email with Million Verifier as a run phase.
  verify: boolean;
  // Discover the decision-maker's name + title (decision-maker Layer 1/2) so
  // pattern_mv can build their personal email. The owner-name add-on, primarily
  // for name-less Google-Maps business leads (migration 00079).
  naming: boolean;
  // Keep the best pattern guess on a catch-all domain (confidence 40, flagged
  // catch_all) instead of discarding it. Per-run OR over the org-level
  // accept_catch_all_guesses setting — the run's waterfall_config snapshot is
  // overridden to true when any enrolled contact carries this stamp.
  include_catch_all: boolean;
}

export const DEFAULT_ENRICHMENT_ADDONS: EnrichmentAddons = {
  activity: false,
  verify: false,
  naming: false,
  include_catch_all: false,
};

// Org-level enrichment/waterfall config (organizations.enrichment_settings, JSONB).
// NULL in the DB → these code defaults. Snapshotted onto each run's
// waterfall_config so an in-flight run never re-reads live settings.
export interface EnrichmentSettings {
  // Master switch for the whole second-pass waterfall.
  waterfall_enabled: boolean;
  // Employee-count boundary between the small and large size bands.
  size_threshold: number;
  // Method per size band. `unknown_method` covers items with no known count.
  small_method: EnrichmentWaterfallMethod;
  large_method: EnrichmentWaterfallMethod;
  unknown_method: EnrichmentWaterfallMethod;
  // Whether pattern_mv may auto-write a catch-all guess (Phase 2 gate).
  accept_catch_all_guesses: boolean;
  // Max pages the site scraper crawls per domain (Phase 3).
  scrape_max_pages: number;
  // Kill-switch: when true, a completed LinkedIn search auto-imports every
  // sourced profile into Contacts and starts enrichment (migration 00077). When
  // false, import stays the manual "Import to Contacts" click.
  auto_run_after_search: boolean;
  // When true, the domains phase discovers a website domain via web lookup
  // (Perplexity/Claude) for contacts whose employer has no LinkedIn company page,
  // so the email waterfall can still run for them. Validated against the live
  // site before saving. No LinkedIn-company charge; ~$0.005/company web lookup.
  domain_discovery_enabled: boolean;
}

// Defaults route every band to pattern_mv (pattern-permutation + Million
// Verifier) — ~$0.004/contact, surgical, no Apify. site_scrape / scrape_plus_pattern
// and the bovi fallback are opt-in per band.
export const DEFAULT_ENRICHMENT_SETTINGS: EnrichmentSettings = {
  waterfall_enabled: true,
  size_threshold: 50,
  small_method: "pattern_mv",
  large_method: "pattern_mv",
  unknown_method: "pattern_mv",
  accept_catch_all_guesses: false,
  // 6 (not 4): owner wants team/leadership/staff pages in the crawl — they're
  // where personMatch hits live. Discovery-driven selection keeps this cheap.
  scrape_max_pages: 6,
  // On by default: a finished search flows straight into enrichment so the
  // pipeline doesn't stall at "sourced". Owners can flip it off to curate which
  // rows enter the CRM (manual Import to Contacts).
  auto_run_after_search: true,
  // On by default: recovers the ~50% of small-business contacts whose employer
  // has no LinkedIn page (they'd otherwise dead-end with no domain, no email).
  domain_discovery_enabled: true,
};

export interface EnrichmentRun {
  id: string;
  organization_id: string;
  created_by: string;
  // provider snapshots
  profile_actor: string;
  domain_actor: string;
  waterfall_actor: string | null;
  activity_actor: string | null;
  // Enrichment settings snapshot at run-start (migration 00075). NULL for runs
  // created before the waterfall-settings feature.
  waterfall_config: EnrichmentSettings | null;
  run_profiles: boolean;
  run_domains: boolean;
  run_waterfall: boolean;
  run_activity: boolean;
  // Opt-in email-verification phase (migration 00077). Off on runs created
  // before the add-on existed.
  run_verify: boolean;
  // Opt-in decision-maker naming phase (migration 00079). Off on older runs.
  run_naming: boolean;
  phase: EnrichmentPhase;
  status: EnrichmentRunStatus;
  total_count: number;
  phase_total_count: number;
  processed_count: number;
  found_emails_profiles_count: number;
  found_domains_count: number;
  found_emails_waterfall_count: number;
  found_emails_count: number;
  found_activity_count: number;
  // Emails that verified clean (MV "ok") in the verify phase (migration 00077).
  found_verified_count: number;
  // Decision-maker names found in the naming phase (migration 00079).
  found_names_count: number;
  // Delivered-outcome ledger, classified at completion (migration 00079 / Phase 5).
  outcome_counts: Record<string, number>;
  cost_usd: number | string;
  active_apify_run_id: string | null;
  active_apify_dataset_id: string | null;
  active_batch_started_at: string | null;
  active_batch_attempt: number;
  consecutive_failures: number;
  locked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  progress_message: string | null;
  error_message: string | null;
  created_at: string;
}

export interface EnrichmentRunItem {
  id: string;
  run_id: string;
  organization_id: string;
  contact_id: string;
  linkedin_url: string | null;
  profile_id: string | null;
  company_linkedin_url: string | null;
  company_id: string | null;
  company_slug: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
  // Which waterfall method advancePhase routed this item to (migration 00075).
  // NULL until the waterfall phase stamps it (Phase 2 routing).
  waterfall_method: EnrichmentWaterfallMethod | null;
  // Employee count captured in the domains phase — the size-routing input.
  employee_count: number | null;
  profile_status: EnrichmentStepStatus;
  profile_apify_run_id: string | null;
  profile_notes: string | null;
  domain_status: EnrichmentStepStatus;
  domain_apify_run_id: string | null;
  domain_notes: string | null;
  // Opt-in naming (decision-maker) phase (migration 00079). NULL = not part of
  // naming. `title` holds the discovered role.
  naming_status: EnrichmentStepStatus | null;
  naming_notes: string | null;
  title: string | null;
  waterfall_status: EnrichmentStepStatus | null;
  waterfall_apify_run_id: string | null;
  waterfall_notes: string | null;
  activity_status: EnrichmentStepStatus | null;
  activity_apify_run_id: string | null;
  activity_notes: string | null;
  last_posted_at: string | null;
  recent_post_count: number | null;
  // step 5 (opt-in): verify (Million Verifier). NULL = not part of verification.
  verify_status: EnrichmentStepStatus | null;
  verify_notes: string | null;
  // MV verdict for the found email: 'ok' | 'catch_all' | 'unknown' | 'invalid'
  // | 'disposable' (null until verified).
  verification_result: string | null;
  email: string | null;
  // Which Apify actor supplied `email` (provenance). Verification is Million
  // Verifier's job on the contact, not tracked per enrichment item.
  email_provider: EmailProviderId | null;
  confidence: number | null;
  attempts: number;
  cost_usd: number | string;
  created_at: string;
  updated_at: string;
}
