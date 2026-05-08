// Salesforge.ai API types (legacy / public v2 surface).
//
// All types here track the OpenAPI spec at
// https://api.salesforge.ai/public/v2/swagger/doc3.json — see
// docs/salesforge-api-reference.md for the gotchas. Field names use the
// API's camelCase convention (workspaceId, sequenceID, contactIds, etc.)
// rather than snake_case so request bodies don't need rewriting.

// ===== ME / WORKSPACES / PRODUCTS =====

// GET /me returns { accountId, apiKeyName } — the api-key-scoped account.
export interface SalesforgeMe {
  accountId: string;
  apiKeyName?: string;
}

// Salesforge wraps list responses in a paginated envelope.
export interface SalesforgeListEnvelope<T> {
  total: number;
  offset: number;
  limit: number;
  data: T[];
}

export interface SalesforgeWorkspace {
  id: string;
  accountId?: string;
  name: string;
  slug?: string;
}

export type SalesforgeWorkspaceList = SalesforgeListEnvelope<SalesforgeWorkspace>;

export interface SalesforgeProduct {
  id: string;
  name: string;
}

export type SalesforgeProductList = SalesforgeListEnvelope<SalesforgeProduct>;

// ===== SEQUENCES =====

// SequenceStatus values that the legacy /status PUT accepts. The spec
// also lists 'deleted', 'completed', 'video_pending' but only the four
// here are user-actionable.
export type SalesforgeSequenceStatus =
  | "active"
  | "paused"
  | "draft"
  | "completed";

// Languages Salesforge supports for sequence content. Used as the
// `language` field on POST /sequences.
export type SalesforgeLanguage =
  | "american_english"
  | "british_english"
  | "russian"
  | "ukrainian"
  | "finnish"
  | "french"
  | "spanish"
  | "polish"
  | "romanian"
  | "german"
  | "lithuanian"
  | "dutch"
  | "latvian"
  | "italian"
  | "czech"
  | "hungarian"
  | "japanese"
  | "brazilian_portugese"
  | "swedish"
  | "danish"
  | "norwegian"
  | "estonian";

export interface SalesforgeSequence {
  id: string;
  name: string;
  status?: SalesforgeSequenceStatus | string;
  workspaceId?: string;
  productId?: string;
  // Counts surface on the SequenceResponse — kept optional since most
  // call sites don't read them.
  leadCount?: number;
  contactedCount?: number;
  openedCount?: number;
  repliedCount?: number;
  bouncedCount?: number;
  completedCount?: number;
}

export type SalesforgeSequenceList = SalesforgeListEnvelope<SalesforgeSequence>;

// POST /workspaces/{ws}/sequences body.
export interface SalesforgeCreateSequenceRequest {
  name: string;
  productId: string;
  language: SalesforgeLanguage;
  timezone: string; // IANA tz, e.g. "America/New_York"
}

// PUT /workspaces/{ws}/sequences/{seq}/steps body. Each step has an
// `id` (Salesforge generates one if you pass an empty string for new
// steps) and an array of variants. A step with one variant is the
// common case; multiple variants enable A/B testing.
export interface SalesforgeStepVariantRequest {
  // `label` is the only required field. Pass "A" / "B" / etc. for A/B
  // tests, or any short identifier for a single-variant step.
  label: string;
  emailSubject?: string;
  emailContent?: string; // HTML or plain text
  // Salesforge sets these implicitly for single-variant steps; only
  // populate them when building an A/B test by hand.
  distributionWeight?: number;
  order?: number;
  id?: string;
}

export interface SalesforgeStepRequest {
  id?: string; // empty for new steps
  name?: string;
  order: number; // 0-indexed step position
  waitDays: number; // days to wait BEFORE this step fires (0 for the first step)
  variants: SalesforgeStepVariantRequest[];
  distributionStrategy?: "equal" | "custom";
}

export interface SalesforgeUpdateStepsRequest {
  steps: SalesforgeStepRequest[];
}

// PUT /workspaces/{ws}/sequences/{seq}/mailboxes body.
export interface SalesforgeAssignMailboxesRequest {
  mailboxIds: string[];
}

// PUT /workspaces/{ws}/sequences/{seq}/status body.
export interface SalesforgeUpdateStatusRequest {
  status: SalesforgeSequenceStatus;
}

// GET /workspaces/{ws}/sequences/{seq}/analytics returns
// { days: { 'YYYY-MM-DD': SequenceAnalyticsDayResponse }, stats: {...} }
// — note `days` is an object map, not an array.
export interface SalesforgeAnalyticsDay {
  sent?: number;
  replied?: number;
  totalOpened?: number;
  uniqueOpened?: number;
  totalClicked?: number;
  uniqueClicked?: number;
}

export interface SalesforgeAnalyticsStats {
  contacted?: number;
  opened?: number;
  openedPercent?: number;
  replied?: number;
  repliedPercent?: number;
  repliedPositive?: number;
  repliedPositivePercent?: number;
  clicked?: number;
  clickedPercent?: number;
}

export interface SalesforgeAnalytics {
  days?: Record<string, SalesforgeAnalyticsDay>;
  stats?: SalesforgeAnalyticsStats;
}

// ===== MAILBOXES =====

export interface SalesforgeMailbox {
  id: string;
  email: string;
  status?: string;
  dailyLimit?: number;
  workspaceId?: string;
  warmupEnabled?: boolean;
}

export type SalesforgeMailboxList = SalesforgeListEnvelope<SalesforgeMailbox>;

// ===== EMAILS =====

export interface SalesforgeEmail {
  id: string;
  thread_id?: string;
  mailbox_id?: string;
  workspace_id?: string;
  subject?: string;
  from_address?: string;
  from_name?: string;
  to_addresses?: string[];
  body_text?: string;
  body_html?: string;
  received_at?: string;
}

// POST /workspaces/{ws}/mailboxes/{mb}/emails/{em}/reply body.
// Salesforge infers subject from the original thread; no subject field.
export interface SalesforgeReplyRequest {
  body_text: string;
  body_html?: string;
  cc_addresses?: string[];
  bcc_addresses?: string[];
}

// ===== CONTACTS =====

// POST /workspaces/{ws}/contacts/bulk request body uses the
// CreateSimpleLeadRequest shape — note `position` (not `title`),
// `customVars` (not `custom_variables`), and no `phone` field.
//
// `firstName` is the only documented required field.
export interface SalesforgeContactCreate {
  firstName: string;
  email?: string;
  lastName?: string;
  company?: string;
  position?: string;
  linkedinUrl?: string;
  customVars?: Record<string, string>;
  tags?: string[];
  tagIds?: string[];
}

// POST /workspaces/{ws}/contacts/bulk response — Salesforge returns
// `{contacts: [...]}` but the array element shape is undocumented in
// the spec. We treat it as a permissive object so callers can read
// `id`/`email` when present.
export interface SalesforgeContactBulkResponse {
  contacts?: Array<{
    id?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
  }>;
}

// PUT /workspaces/{ws}/sequences/{seq}/contacts body — note camelCase
// `contactIds`, NOT `contact_ids`.
export interface SalesforgeAssignContactsRequest {
  contactIds: string[];
}

// ===== WEBHOOKS =====

// All webhook event types Salesforge can fire. The seven below are the
// ones we register for our reply-routing pipeline. Spec also lists
// email_sent / email_opened / link_clicked / linkedin_replied — kept
// in the union for completeness but we don't subscribe to them.
export type SalesforgeWebhookType =
  | "email_replied"
  | "positive_reply"
  | "negative_reply"
  | "email_bounced"
  | "contact_unsubscribed"
  | "dnc_added"
  | "label_changed"
  | "email_sent"
  | "email_opened"
  | "link_clicked"
  | "linkedin_replied";

// The 7 event types we actually subscribe to per sequence.
export const SALESFORGE_REPLY_PIPELINE_EVENTS: SalesforgeWebhookType[] = [
  "email_replied",
  "positive_reply",
  "negative_reply",
  "email_bounced",
  "contact_unsubscribed",
  "dnc_added",
  "label_changed",
];

// POST /workspaces/{ws}/integrations/webhooks body. Note `sequenceID`
// is camelCase with capital ID — the spec is inconsistent about case.
export interface SalesforgeCreateWebhookRequest {
  name: string;
  type: SalesforgeWebhookType;
  url: string;
  sequenceID?: string;
}

// GET /workspaces/{ws}/integrations/webhooks response item — note
// `sequenceId` here uses lowercase `d` (different from the Create
// request's `sequenceID`).
export interface SalesforgeWebhook {
  id: string;
  name: string;
  type: SalesforgeWebhookType | string;
  url: string;
  sequenceId?: string;
  sentCount?: number;
}

export type SalesforgeWebhookList = SalesforgeListEnvelope<SalesforgeWebhook>;

// Webhook delivery payload — undocumented shape. The handler in
// src/app/api/webhooks/salesforge/route.ts uses defensive parsing
// before reading any field.
export type SalesforgeWebhookPayload = Record<string, unknown>;

// ===== SEQUENCE READS (extending GET /sequences/{id}) =====

// Returned alongside a sequence's `mailboxes` array on
// GET /sequences/{id}. Lets the edit-sequence UI pre-select assigned
// mailboxes without a second fetch.
export interface SalesforgeSequenceMailbox {
  id: string;
  address: string;
  firstName?: string;
  lastName?: string;
}

// Variant on a step — same shape as the upsert request, plus runtime
// fields the API echoes back.
export interface SalesforgeStepVariantResponse {
  id: string;
  label: string;
  emailSubject?: string;
  emailContent?: string;
  order?: number;
  distributionWeight?: number;
  status?: string;
  isGenerated?: boolean;
}

export interface SalesforgeStepResponse {
  id: string;
  name?: string;
  order: number;
  waitDays: number;
  variants: SalesforgeStepVariantResponse[];
  distributionStrategy?: "equal" | "custom";
}

// Full sequence detail (the response of GET /sequences/{id}).
// Subset of api.SequenceResponse — only the fields the edit UI reads.
export interface SalesforgeSequenceDetail extends SalesforgeSequence {
  steps?: SalesforgeStepResponse[];
  mailboxes?: SalesforgeSequenceMailbox[];
  agentId?: string;
  openTrackingEnabled?: boolean;
  clickTrackingEnabled?: boolean;
  localizedOptOutEnabled?: boolean;
  companyOutreachLimitEnabled?: boolean;
  companyOutreachLimitCount?: number;
  sequentialCompanySendingEnabled?: boolean;
}

// ===== SCHEDULES =====

// One row of the sending schedule. weekday is 0–6 (Sunday=0). hours
// are local to the sequence's timezone (set on createSequence).
export interface SalesforgeSchedule {
  id?: string;
  weekday: number;     // 0=Sun, 1=Mon, ..., 6=Sat
  fromHour: number;    // 0–23
  toHour: number;      // 0–23 (exclusive); 17 = stop sending at 5pm
}

export interface SalesforgeUpdateSchedulesRequest {
  schedules: SalesforgeSchedule[];
}

// ===== THREADS (inbox) =====

// One row in the workspace threads list. Salesforge calls this a
// "primebox thread" — it's the per-conversation summary the inbox UI
// shows. Use getThread for the full message list.
export interface SalesforgePrimeboxThread {
  id: string;
  contactEmail?: string;
  contactFirstName?: string;
  contactLastName?: string;
  subject?: string;
  content?: string;       // last message preview
  date?: string;
  isPositive?: boolean;
  isUnread?: boolean;
  labelId?: string;
  mailboxId?: string;
  agentId?: string;
  agentReply?: string;
  agentStatus?: string;
  replyType?: string;
}

export type SalesforgePrimeboxThreadList = SalesforgeListEnvelope<SalesforgePrimeboxThread>;

// Filters for GET /workspaces/{ws}/threads.
export interface SalesforgeThreadsListParams {
  limit?: number;
  offset?: number;
  mailboxIds?: string[];
  agentIds?: string[];
  sequenceIds?: string[];
  positive?: boolean;
  filter?: string;
  labels?: string[];
  excludeLabels?: string[];
  q?: string; // text search
}

// Per-message detail in a thread.
export interface SalesforgeThreadEmail {
  id: string;
  emailId?: string;
  type?: string;       // "sent" | "received" | etc.
  subject?: string;
  fromAddress?: string;
  toAddress?: string;
  content?: string;
  date?: string;
  tos?: Array<{ address?: string; name?: string }>;
  ccs?: Array<{ address?: string; name?: string }>;
  bccs?: Array<{ address?: string; name?: string }>;
}

export interface SalesforgeThreadContact {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  linkedinUrl?: string;
}

export interface SalesforgeThreadSequenceSummary {
  id?: string;
  name?: string;
  status?: string;
  product?: { id?: string; name?: string };
}

// Full thread response from GET /mailboxes/{mb}/threads/{th}.
export interface SalesforgeThreadDetail {
  contact?: SalesforgeThreadContact;
  sequence?: SalesforgeThreadSequenceSummary;
  emails?: SalesforgeThreadEmail[];
}

// PUT /threads/{id}/label body — `labelId` references a primebox label
// id from listPrimeboxLabels.
export interface SalesforgeUpdateThreadLabelRequest {
  labelId: string;
}

// One label option (returned by listPrimeboxLabels). isBuiltIn=true
// means a Salesforge-default label like "Hot" / "Cold" / etc.
export interface SalesforgePrimeboxLabel {
  id: string;
  name: string;
  isBuiltIn?: boolean;
  specialLabel?: string;
}

export type SalesforgePrimeboxLabelList = SalesforgeListEnvelope<SalesforgePrimeboxLabel>;

// ===== EMAIL VALIDATION =====

// GET /sequences/{id}/contacts/validation/result response.
export interface SalesforgeValidationResults {
  status: "in_progress" | "completed" | string;
  progress: number; // 0-100
  result?: SalesforgeValidationResultByEsp;
}

// LeadsESPValidationResult is a map keyed by ESP name → counts. The
// spec doesn't enumerate ESPs, so we model permissively.
export type SalesforgeValidationResultByEsp = Record<
  string,
  SalesforgeValidationCounts
>;

export interface SalesforgeValidationCounts {
  catch_all?: number;
  disabled?: number;
  disposable?: number;
  inbox_full?: number;
  invalid?: number;
  role_account?: number;
  safe?: number;
  spam_trap?: number;
  unknown?: number;
  unvalidated?: number;
}

// ESP enum from the spec.
export type SalesforgeLeadESP =
  | "empty"
  | "gmail"
  | "gsuite"
  | "icloud"
  | "outlook"
  | "ms365"
  | "yandex"
  | "yahoo"
  | "unknown"
  | "mailcom"
  | "proofpoint"
  | "antispamsoftware";

export type SalesforgeReonEmailStatus =
  | "safe"
  | "invalid"
  | "disabled"
  | "disposable"
  | "inbox_full"
  | "catch_all"
  | "role_account"
  | "spamtrap"
  | "unknown"
  | "unvalidated";

// Confirm body — tell Salesforge which ESP+status combinations to
// proceed sending to. Empty array = drop all validated-bad contacts.
export interface SalesforgeConfirmValidationRequest {
  esps: SalesforgeLeadESP[];
  statuses?: SalesforgeReonEmailStatus[];
}

// ===== PRODUCT CREATION =====

export interface SalesforgeProductRequest {
  name: string;
  internalName?: string;
  language?: SalesforgeLanguage;
  industry?: string;
  idealCustomerProfile?: string;
  pain?: string;
  costOfInaction?: string;
  solution?: string;
  proofPoints?: string;
}

export interface SalesforgeCreateProductRequest {
  product: SalesforgeProductRequest;
  translation?: SalesforgeProductRequest[];
}

// ===== DNC =====

export interface SalesforgeBulkDNCRequest {
  dncs: string[]; // email addresses to add to do-not-contact list
}

// ===== CUSTOM VARIABLES =====

export interface SalesforgeCustomVariable {
  id?: string;
  name?: string;
  description?: string;
  defaultValue?: string;
}

export type SalesforgeCustomVariableList = SalesforgeListEnvelope<SalesforgeCustomVariable>;

// ===== WORKSPACE SEQUENCE METRICS =====

// Roll-up across all (or filtered) sequences in the workspace.
export interface SalesforgeWorkspaceSequenceMetrics {
  contacted?: number;
  opened?: number;
  openedPercent?: number;
  clicked?: number;
  clickedPercent?: number;
  replied?: number;
  repliedPercent?: number;
  repliedPositive?: number;
  repliedPositivePercent?: number;
  bounced?: number;
  bouncedPercent?: number;
}
