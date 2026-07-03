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
  // Salesforge (migration 00049). One workspace per org; default product
  // id is used for newly-created sequences. Auth uses the raw key (no
  // Bearer prefix). Warmforge is Salesforge's mailbox-warming sister
  // product with its own API key.
  salesforge_api_key: string | null;
  salesforge_workspace_id: string | null;
  salesforge_default_product_id: string | null;
  warmforge_api_key: string | null;
  // Native email channel (migration 00056). A Google service account with
  // domain-wide delegation; the key impersonates any mailbox on an
  // authorized domain. Same trust boundary as the other org-level keys.
  gmail_service_account_email: string | null;
  gmail_service_account_key: string | null;
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

export interface Campaign {
  id: string;
  // NULL for "orphan" campaigns — rows imported by the discovery cron
  // before an owner has linked them to a LeadStart client. Existing admin
  // surfaces filter or degrade gracefully when client_id is NULL.
  client_id: string | null;
  organization_id: string;
  // Salesforge sequence id (migration 00049). Populated for
  // source_channel='salesforge' rows; null for linkedin.
  salesforge_sequence_id: string | null;
  // Per-campaign daily cap on new Salesforge enrollments (migration 00050).
  // NULL = dispatcher falls back to DEFAULT_DAILY_CAP=66.
  salesforge_daily_contact_cap: number | null;
  // Per-campaign Salesforge tags attached to every contact the
  // dispatcher bulk-creates (migration 00054). NULL or empty array =
  // dispatcher uses the contact's own tags, or "leadstart" fallback.
  salesforge_default_tags: string[] | null;
  // Mapping from Salesforge custom-variable names to LeadStart contact
  // column names. The dispatcher reads the named column per-contact
  // and sends it under the Salesforge name in customVars.
  // Example: { "intro": "intro_line", "notes": "notes" }
  salesforge_custom_var_mapping: Record<string, string> | null;
  // User-chosen CSV header → LeadStart field mapping, persisted per
  // campaign so re-uploads pre-populate the mapping UI (migration 00055).
  csv_column_mapping: Record<string, string> | null;
  name: string;
  status: CampaignStatus;
  // Channel discriminator. 'linkedin' for Unipile-driven sequences;
  // 'salesforge' for the email channel.
  source_channel: SourceChannel;
  // Per-campaign Unipile account binding (migration 00046). Defaults to
  // clients.unipile_account_id but lives on the campaign so accounts can
  // rotate without invalidating campaign history.
  unipile_account_id: string | null;
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
  // provider so the Events page can filter Salesforge vs Unipile traffic.
  source_channel: SourceChannel;
}

// Contacts (campaign leads)
export type ContactStatus = "new" | "enriched" | "queued" | "uploaded" | "active" | "bounced" | "replied" | "unsubscribed";

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
  linkedin_url: string | null;
  intro_line: string | null;
  enrichment_data: Record<string, unknown>;
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

export type SourceChannel = "linkedin" | "salesforge" | "native_email";

export interface LeadReply {
  id: string;
  organization_id: string;
  // NULL for orphan replies — replies captured by the webhook handler
  // when the campaign wasn't yet linked to a LeadStart client. The
  // classifier still runs; notification is skipped until B3 links the
  // campaign and a follow-up UPDATE populates client_id.
  client_id: string | null;
  campaign_id: string | null;
  // Channel discriminator (migration 00045). 'linkedin' for inbound DMs
  // ingested by the Unipile webhook; 'salesforge' for email replies.
  source_channel: SourceChannel;

  // Unipile references (migration 00046). Populated for LinkedIn DMs.
  // unipile_message_id is org-scoped unique for webhook dedup;
  // unipile_chat_id threads messages within a chat.
  unipile_message_id: string | null;
  unipile_chat_id: string | null;
  // Salesforge references (migration 00049). Populated for
  // source_channel='salesforge' rows. The trio (workspace, mailbox,
  // email_id) is what POST .../emails/{em}/reply needs — workspace lives
  // on organizations, mailbox + email id live here. salesforge_email_id
  // is org-scoped unique for webhook dedup (Salesforge does not expose
  // RFC 5322 message-id).
  salesforge_email_id: string | null;
  salesforge_thread_id: string | null;
  salesforge_mailbox_id: string | null;
  // Native email references (migration 00056). Populated for
  // source_channel='native_email' rows. gmail_message_id is org-scoped
  // unique for poller dedup; native_mailbox_id routes the outbound reply
  // back through the mailbox that received it.
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  native_mailbox_id: string | null;

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

  // Send (manual reply composed by the client via /api/replies/[id]/send)
  status: ReplyStatus;
  final_body_text: string | null;
  final_body_html: string | null;
  sent_at: string | null;
  // Outbound provider id (Salesforge email id, etc.) returned from the
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
  created_at: string;
  updated_at: string;
}

export type NativeSendStatus = "sent" | "bounced";

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
