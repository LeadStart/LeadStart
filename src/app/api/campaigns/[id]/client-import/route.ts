// GET/POST /api/campaigns/[id]/client-import — CSV contact import for native
// email campaigns, callable by the campaign's own client (portal self-service)
// or owner/va (admin). Not under /api/admin because clients must reach it; the
// role-branching auth mirrors /api/replies/[id]/send.
//
// GET  → panel bootstrap: campaign summary, the distinct {{token}} set the
//        campaign's step templates use (standard vs custom), the saved column
//        mapping, and the per-request row cap.
// POST → sanitized rows in, contacts + enrollments out. The CSV is parsed in
//        the browser (same stance as the admin import panel); this route never
//        sees the raw file.
//
// Security notes:
//   - contacts RLS is being locked down to owner/va (migration 00062), so all
//     reads/writes here go through the service-role client after explicit
//     checks. organization_id / client_id / campaign_id are always forced from
//     the server-loaded campaign row — never from the request body.
//   - Dedup is CLIENT-scoped. The org-wide unique index
//     idx_contacts_org_email_unique means an email can exist at most once per
//     org; if it already belongs to a different client (or LeadStart's own
//     CRM, client_id NULL), the row is SKIPPED — never reassigned, never
//     duplicated. A client can technically probe whether an email exists
//     somewhere in the org via the skipped count; accepted for trusted
//     paying clients.
//   - Emails are validated strictly (single @, no whitespace/control chars,
//     ≤254) because contact.email flows raw into the Gmail To: header — this
//     is the import-side half of the header-injection fix (the sink half is
//     in src/lib/gmail/mime.ts).
//   - All values have ASCII control chars stripped: custom_fields values are
//     substituted into subject templates at send time, so a CRLF smuggled
//     through a quoted CSV cell must die here.
//
// Failure ordering (no cross-statement transaction available): contacts
// insert (one atomic statement) → per-row links → enrollment upsert → alert
// (best-effort). Every step is idempotent; re-uploading the same file is the
// recovery path and re-enrolls nobody (UNIQUE (campaign_id, contact_id)).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  extractCampaignTokens,
  normalizeVarKey,
  SENDER_TOKEN_KEYS,
} from "@/lib/native/tokens";
import { CUSTOM_TARGET_PREFIX, MAPPING_TARGETS } from "@/lib/csv/parse-contacts";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MAX_IMPORT_ROWS = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Per-client rows/day across all uploads — flood brake, not a business quota.
const DAILY_ROW_BUDGET = 5000;

const MAX_CUSTOM_KEYS_PER_ROW = 30;
const MAX_CUSTOM_KEY_LEN = 64;
const MAX_CUSTOM_VALUE_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 64;
// JSONB keys that would collide with Object.prototype when the token map is
// built as a plain object at send time.
const FORBIDDEN_CUSTOM_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const STANDARD_FIELD_CAPS: Record<string, number> = {
  first_name: 200,
  last_name: 200,
  company_name: 200,
  title: 200,
  phone: 50,
  linkedin_url: 2000,
  intro_line: 2000,
  notes: 2000,
};

// ── Sanitizers ────────────────────────────────────────────────────────────

// Strip ASCII control chars (incl. CR/LF/NUL — subject-header injection
// vector via {{token}} substitution) and collapse whitespace runs.
function cleanValue(v: unknown, cap: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
  return s || null;
}

// Conservative single-address validator. Stricter than the codebase's usual
// `includes("@")` because this is an untrusted client path and the address
// (a) flows into the Gmail To: header and (b) is interpolated into PostgREST
// filter values — so it must exclude commas, quotes, parens, and other filter
// metacharacters as well as CR/LF. Requires a dotted domain. Not full RFC 5322
// (which nobody needs for cold-outreach lists).
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
function validEmail(e: string): boolean {
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

interface SanitizedRow {
  email: string; // lowercase
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  linkedin_url: string | null;
  intro_line: string | null;
  notes: string | null;
  tags: string[];
  custom_fields: Record<string, string>;
}

function sanitizeRow(raw: unknown): SanitizedRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const emailRaw = typeof r.email === "string" ? r.email.trim() : "";
  if (!validEmail(emailRaw)) return null;

  const out: SanitizedRow = {
    email: emailRaw.toLowerCase(),
    first_name: cleanValue(r.first_name, STANDARD_FIELD_CAPS.first_name),
    last_name: cleanValue(r.last_name, STANDARD_FIELD_CAPS.last_name),
    company_name: cleanValue(r.company_name, STANDARD_FIELD_CAPS.company_name),
    title: cleanValue(r.title, STANDARD_FIELD_CAPS.title),
    phone: cleanValue(r.phone, STANDARD_FIELD_CAPS.phone),
    linkedin_url: cleanValue(r.linkedin_url, STANDARD_FIELD_CAPS.linkedin_url),
    intro_line: cleanValue(r.intro_line, STANDARD_FIELD_CAPS.intro_line),
    notes: cleanValue(r.notes, STANDARD_FIELD_CAPS.notes),
    tags: [],
    custom_fields: {},
  };

  if (Array.isArray(r.tags)) {
    for (const t of r.tags.slice(0, MAX_TAGS)) {
      const tag = cleanValue(t, MAX_TAG_LEN);
      if (tag) out.tags.push(tag);
    }
  }

  if (r.custom_fields && typeof r.custom_fields === "object") {
    let kept = 0;
    for (const [k, v] of Object.entries(r.custom_fields as Record<string, unknown>)) {
      if (kept >= MAX_CUSTOM_KEYS_PER_ROW) break;
      const key = cleanValue(k, MAX_CUSTOM_KEY_LEN);
      if (!key || FORBIDDEN_CUSTOM_KEYS.has(key)) continue;
      // A custom field must never shadow a sender-identity token: those are
      // resolved from the sending mailbox, never the contact. Without this, a
      // client row with custom_fields {"Your Name": "..."} would override the
      // mailbox signature that {{YourName}} renders at send time.
      if (SENDER_TOKEN_KEYS.has(normalizeVarKey(key))) continue;
      const value = cleanValue(v, MAX_CUSTOM_VALUE_LEN);
      if (value == null) continue;
      out.custom_fields[key] = value;
      kept++;
    }
  }

  return out;
}

// ── Shared auth ───────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  organization_id: string;
  client_id: string | null;
  name: string;
  status: string;
  source_channel: string;
  csv_column_mapping: Record<string, string> | null;
}

type Authorized = {
  campaign: CampaignRow;
  admin: ReturnType<typeof createAdminClient>;
  userEmail: string;
  isAdmin: boolean;
};

async function authorize(
  campaignId: string,
): Promise<Authorized | NextResponse> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, client_id, name, status, source_channel, csv_column_mapping",
    )
    .eq("id", campaignId)
    .maybeSingle();
  const campaign = data as CampaignRow | null;
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const role = user.app_metadata?.role;
  if (role === "owner" || role === "va") {
    if (campaign.organization_id !== user.app_metadata?.organization_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    // Client role: must be linked to the campaign's client.
    if (!campaign.client_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", campaign.client_id)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (campaign.source_channel !== "native_email") {
    return NextResponse.json(
      { error: "CSV import is only available for native email campaigns" },
      { status: 422 },
    );
  }

  return {
    campaign,
    admin,
    userEmail: user.email ?? "",
    isAdmin: role === "owner" || role === "va",
  };
}

// ── GET: panel bootstrap ──────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authorize(id);
  if (auth instanceof NextResponse) return auth;
  const { campaign, admin } = auth;

  const { data: steps } = await admin
    .from("campaign_steps")
    .select("subject_template, body_template")
    .eq("campaign_id", campaign.id)
    .order("step_index", { ascending: true });

  const templates: (string | null)[] = [];
  for (const s of (steps ?? []) as {
    subject_template: string | null;
    body_template: string | null;
  }[]) {
    templates.push(s.subject_template, s.body_template);
  }

  return NextResponse.json({
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    tokens: extractCampaignTokens(templates),
    saved_mapping: campaign.csv_column_mapping ?? null,
    max_rows: MAX_IMPORT_ROWS,
  });
}

// ── POST: import ──────────────────────────────────────────────────────────

interface ImportBody {
  rows?: unknown;
  column_mapping?: unknown;
  filename?: unknown;
}

const VALID_STANDARD_TARGETS = new Set([
  ...MAPPING_TARGETS.map((t) => t.value),
  "pipeline_stage",
]);

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (rawRows.length === 0) {
    return NextResponse.json({ error: "rows is required" }, { status: 400 });
  }
  if (rawRows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_IMPORT_ROWS} rows per import — split the file` },
      { status: 400 },
    );
  }

  const auth = await authorize(id);
  if (auth instanceof NextResponse) return auth;
  const { campaign, admin, userEmail, isAdmin } = auth;

  // Active-only: matches the dispatcher's own gate so nothing sits enrolled
  // on a campaign that will never send.
  if (campaign.status !== "active") {
    return NextResponse.json(
      { error: "Contacts can only be imported into an active campaign" },
      { status: 409 },
    );
  }
  if (!campaign.client_id) {
    return NextResponse.json(
      { error: "Campaign has no client assigned" },
      { status: 409 },
    );
  }
  const clientId = campaign.client_id;

  // Flood brake: per-client rows/day across all uploads.
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: todayCount } = await admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .gte("created_at", startOfDay.toISOString());
  if ((todayCount ?? 0) + rawRows.length > DAILY_ROW_BUDGET) {
    return NextResponse.json(
      {
        error: `Daily import limit reached (${DAILY_ROW_BUDGET} contacts/day per client). Try again tomorrow.`,
      },
      { status: 429 },
    );
  }

  // ── Sanitize + in-payload dedupe (by lowercased email) ─────────────────
  let skippedInvalidEmail = 0;
  let inFileDuplicates = 0;
  const wanted = new Map<string, SanitizedRow>();
  for (const raw of rawRows) {
    const row = sanitizeRow(raw);
    if (!row) {
      skippedInvalidEmail++;
      continue;
    }
    if (wanted.has(row.email)) {
      inFileDuplicates++;
      continue;
    }
    wanted.set(row.email, row);
  }

  const emails = [...wanted.keys()];

  // ── DNC pre-filter (advisory; the send cron re-checks at send time) ────
  let skippedDnc = 0;
  if (emails.length > 0) {
    const dncEmails = new Set<string>();
    for (const part of chunk(emails, 200)) {
      const { data: dncRows, error: dncErr } = await admin
        .from("dnc_entries")
        .select("email")
        .eq("organization_id", campaign.organization_id)
        .or(`client_id.eq.${clientId},client_id.is.null`)
        .in("email", part);
      // Fail fast rather than silently treating a query error as "nobody is on
      // the DNC list" and enrolling suppressed people.
      if (dncErr) {
        console.error("[client-import] DNC lookup failed:", dncErr);
        return NextResponse.json(
          { error: "Could not check the do-not-contact list — try again." },
          { status: 503 },
        );
      }
      for (const r of (dncRows ?? []) as { email: string }[]) {
        dncEmails.add(r.email.trim().toLowerCase());
      }
    }
    for (const e of dncEmails) {
      if (wanted.delete(e)) skippedDnc++;
    }
  }

  // ── DB dedupe: three buckets under the org-wide unique email index ─────
  interface ExistingContact {
    id: string;
    email: string;
    client_id: string | null;
    status: string;
    custom_fields: Record<string, unknown> | null;
  }
  const existingByEmail = new Map<string, ExistingContact>();
  {
    const remaining = [...wanted.keys()];
    // Payload emails are lowercase and so are rows this route writes; older
    // rows added via the admin panels may be mixed-case and won't match the
    // exact `.in()` filter. Those escape to the insert bucket and would hit the
    // org-wide lower(email) unique index — the insert step degrades to per-row
    // so one such collision can't fail the whole batch.
    for (const part of chunk(remaining, 200)) {
      const { data: rows, error: exErr } = await admin
        .from("contacts")
        .select("id, email, client_id, status, custom_fields")
        .eq("organization_id", campaign.organization_id)
        .in("email", part);
      if (exErr) {
        console.error("[client-import] contact dedupe lookup failed:", exErr);
        return NextResponse.json(
          { error: "Could not check existing contacts — try again." },
          { status: 503 },
        );
      }
      for (const r of (rows ?? []) as ExistingContact[]) {
        existingByEmail.set(r.email.trim().toLowerCase(), r);
      }
    }
  }

  const toInsert: SanitizedRow[] = [];
  const toLink: { row: SanitizedRow; existing: ExistingContact }[] = [];
  let skippedExistingElsewhere = 0;
  let skippedSuppressed = 0;
  const SUPPRESSED_STATUSES = new Set(["bounced", "unsubscribed", "replied"]);

  for (const [email, row] of wanted) {
    const existing = existingByEmail.get(email);
    if (!existing) {
      toInsert.push(row);
    } else if (existing.client_id === clientId) {
      if (SUPPRESSED_STATUSES.has(existing.status)) {
        // Would never send (cron suppression) — keep counts truthful.
        skippedSuppressed++;
      } else {
        toLink.push({ row, existing });
      }
    } else {
      // Belongs to another client or LeadStart's own CRM — never reassign.
      skippedExistingElsewhere++;
    }
  }

  // ── Insert new contacts (single atomic statement) ───────────────────────
  const enrollIds: string[] = [];
  let inserted = 0;
  if (toInsert.length > 0) {
    const payload = toInsert.map((r) => ({
      organization_id: campaign.organization_id,
      client_id: clientId,
      campaign_id: campaign.id,
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      company_name: r.company_name,
      title: r.title,
      phone: r.phone,
      linkedin_url: r.linkedin_url,
      intro_line: r.intro_line,
      notes: r.notes,
      tags: r.tags,
      custom_fields: r.custom_fields,
      enrichment_data: {},
      status: "uploaded",
      source: "client-csv-import",
    }));
    const { data: insertedRows, error } = await admin
      .from("contacts")
      .insert(payload)
      .select("id");
    if (error) {
      if (error.code === "23505") {
        // A case-variant of one or more emails already exists in the org (older
        // mixed-case rows from the admin panels). Re-run row-by-row so the
        // colliding rows are skipped and the rest of the batch still imports.
        for (const one of payload) {
          const { data: oneRow, error: oneErr } = await admin
            .from("contacts")
            .insert(one)
            .select("id")
            .maybeSingle();
          if (oneErr) {
            if (oneErr.code === "23505") {
              skippedExistingElsewhere++;
              continue;
            }
            console.error("[client-import] per-row insert failed:", oneErr);
            return NextResponse.json(
              { error: "Could not save contacts" },
              { status: 500 },
            );
          }
          const oneId = (oneRow as { id: string } | null)?.id;
          if (oneId) {
            inserted++;
            enrollIds.push(oneId);
          }
        }
      } else {
        console.error("[client-import] contacts insert failed:", error);
        return NextResponse.json(
          { error: "Could not save contacts" },
          { status: 500 },
        );
      }
    } else {
      const ids = ((insertedRows as { id: string }[] | null) ?? []).map(
        (r) => r.id,
      );
      inserted = ids.length;
      enrollIds.push(...ids);
    }
  }

  // ── Link existing same-client contacts (merge custom_fields) ────────────
  let linked = 0;
  for (const part of chunk(toLink, 25)) {
    const results = await Promise.all(
      part.map(({ row, existing }) =>
        admin
          .from("contacts")
          .update({
            campaign_id: campaign.id,
            custom_fields: {
              ...((existing.custom_fields as Record<string, unknown>) ?? {}),
              ...row.custom_fields,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .then(({ error }) => (error ? null : existing.id)),
      ),
    );
    for (const idOk of results) {
      if (idOk) {
        linked++;
        enrollIds.push(idOk);
      }
    }
  }

  // ── Enroll (idempotent via UNIQUE (campaign_id, contact_id)) ────────────
  let enrolled = 0;
  if (enrollIds.length > 0) {
    const rows = enrollIds.map((contactId) => ({
      campaign_id: campaign.id,
      contact_id: contactId,
      current_step_index: 0,
      status: "active" as const,
    }));
    const { data: enrolledRows, error } = await admin
      .from("campaign_enrollments")
      .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
      .select("id");
    if (error) {
      console.error("[client-import] enrollment upsert failed:", error);
      return NextResponse.json(
        {
          error:
            "Contacts were saved but could not be enrolled. Re-upload the same file to retry.",
        },
        { status: 500 },
      );
    }
    enrolled = ((enrolledRows as { id: string }[] | null) ?? []).length;
  }
  const alreadyEnrolled = enrollIds.length - enrolled;

  // ── Persist the column mapping for next upload ──────────────────────────
  if (body.column_mapping && typeof body.column_mapping === "object") {
    const mapping: Record<string, string> = {};
    for (const [header, target] of Object.entries(
      body.column_mapping as Record<string, unknown>,
    )) {
      if (typeof target !== "string" || !target) continue;
      const validTarget =
        VALID_STANDARD_TARGETS.has(target) ||
        (target.startsWith(CUSTOM_TARGET_PREFIX) &&
          target.length > CUSTOM_TARGET_PREFIX.length &&
          target.length <= 200);
      // Preserve the header exactly as the panel keyed it (it sends h.trim()):
      // only strip control chars and cap length. Do NOT collapse internal
      // whitespace, or "Property  Address" would save as "Property Address"
      // and never match on reload, silently dropping the saved mapping.
      const cleanHeader = header
        .replace(/[\x00-\x1F\x7F]/g, "")
        .trim()
        .slice(0, 200);
      if (validTarget && cleanHeader) mapping[cleanHeader] = target;
    }
    if (Object.keys(mapping).length > 0) {
      await admin
        .from("campaigns")
        .update({ csv_column_mapping: mapping })
        .eq("id", campaign.id);
    }
  }

  // ── Owner alert (best-effort; enqueueOwnerAlert swallows its own errors) ─
  // Fire when contacts were added OR when a batch was skipped as "already in
  // the system" — the latter surfaces a client probing for cross-client email
  // existence, which would otherwise be invisible.
  const added = inserted + linked;
  if (added > 0 || skippedExistingElsewhere > 0) {
    const { data: clientRow } = await admin
      .from("clients")
      .select("name")
      .eq("id", clientId)
      .maybeSingle();
    const clientName =
      (clientRow as { name: string } | null)?.name ?? "Unknown client";
    const filename = cleanValue(body.filename, 120) ?? undefined;
    // Attribute correctly: owner/va uploading from the admin page is not the
    // client self-serving.
    const actor = isAdmin ? `${userEmail} (admin)` : clientName;
    const subject =
      added > 0
        ? `${actor} added ${added} contact${added === 1 ? "" : "s"} to ${campaign.name}`
        : `${actor} uploaded to ${campaign.name} — ${skippedExistingElsewhere} skipped (already in system)`;
    await enqueueOwnerAlert({
      admin,
      kind: "client_csv_upload",
      subject,
      summary: `${actor} imported a CSV into "${campaign.name}" for ${clientName} (${enrolled} newly enrolled, ${skippedExistingElsewhere} already in the system).`,
      context: {
        client_id: clientId,
        client_name: clientName,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        uploaded_by: userEmail,
        uploaded_by_role: isAdmin ? "admin" : "client",
        filename,
        inserted,
        linked,
        enrolled,
        already_enrolled: alreadyEnrolled,
        skipped_invalid_email: skippedInvalidEmail,
        skipped_existing_elsewhere: skippedExistingElsewhere,
        skipped_dnc: skippedDnc,
        skipped_suppressed: skippedSuppressed,
        in_file_duplicates: inFileDuplicates,
      },
    });
  }

  return NextResponse.json({
    inserted,
    linked,
    enrolled,
    already_enrolled: alreadyEnrolled,
    skipped_invalid_email: skippedInvalidEmail,
    skipped_existing_elsewhere: skippedExistingElsewhere,
    skipped_dnc: skippedDnc,
    skipped_suppressed: skippedSuppressed,
    in_file_duplicates: inFileDuplicates,
    total_received: rawRows.length,
  });
}
