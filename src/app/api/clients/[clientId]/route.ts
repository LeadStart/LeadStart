// PATCH /api/clients/[clientId] — role-scoped update of client settings.
//
// Owners: full whitelist (reply-routing, persona, brand, notify classes,
// reports cadence/recipients).
//
// Clients (linked via client_users): a safe subset — their own notification
// routing + signature + report cadence. They cannot touch persona/brand
// fields or auto_notify_classes (those are operational levers admins hold
// for oversight).
//
// The whitelist is enforced server-side, not via RLS, so the UI can't
// privilege-escalate by sending extra fields.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReplyClass } from "@/types/app";

const VALID_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "objection_price",
  "objection_timing",
  "referral_forward",
  "wrong_person_no_referral",
  "ooo",
  "not_interested",
  "unsubscribe",
  "needs_review",
];

// Max CC teammates we'll let a client list. Enough for a real team, low
// enough that a misclick can't spam the inbox.
const MAX_CC_EMAILS = 10;
const MAX_REPORT_RECIPIENTS = 10;

// Basic shape check — not RFC-exact. Server is the last line of defense;
// the real check is Resend rejecting on send. We filter anything obviously
// bogus so we don't pollute the row with empty strings or spaces.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

interface PatchBody {
  notification_email?: string | null;
  notification_cc_emails?: string[];
  phone_number?: string | null;
  auto_notify_classes?: string[];
  persona_name?: string | null;
  persona_title?: string | null;
  persona_linkedin_url?: string | null;
  persona_photo_url?: string | null;
  brand_voice?: string | null;
  signature_block?: string | null;
  report_interval_days?: number | null;
  report_recipients?: string[] | null;
  report_frequency?: string | null;
  report_day_of_week?: number | null;
  report_day_of_month?: number | null;
  report_time_of_day?: string | null;
  report_timezone?: string | null;
  report_schedule_start?: string | null;
}

// Fields a logged-in client is allowed to edit on their own client record.
// Owners get the union of this + the owner-only list below.
const CLIENT_EDITABLE: (keyof PatchBody)[] = [
  "notification_email",
  "notification_cc_emails",
  "phone_number",
  "signature_block",
  "report_interval_days",
  "report_recipients",
  "report_frequency",
  "report_day_of_week",
  "report_day_of_month",
  "report_time_of_day",
  "report_timezone",
  "report_schedule_start",
];

// Report-schedule validation constants (mirrors admin/report-schedule route).
const REPORT_FREQUENCIES = new Set(["weekly", "biweekly", "monthly"]);
const REPORT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const OWNER_ONLY: (keyof PatchBody)[] = [
  "auto_notify_classes",
  "persona_name",
  "persona_title",
  "persona_linkedin_url",
  "persona_photo_url",
  "brand_voice",
];

// Trim strings; map empty/whitespace-only to null so the DB keeps nullable
// columns clean instead of storing "".
function normalizeNullableText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Accept array of email-ish strings; trim, lowercase, dedupe, validate.
function normalizeEmailArray(v: unknown, max: number): string[] | { error: string } {
  if (!Array.isArray(v)) return { error: "Must be an array of email addresses." };
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    if (!EMAIL_SHAPE.test(trimmed)) {
      return { error: `"${raw}" is not a valid email address.` };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
  }
  if (cleaned.length > max) {
    return { error: `Maximum ${max} addresses.` };
  }
  return cleaned;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { clientId } = await params;
  if (!clientId) {
    return NextResponse.json({ error: "Missing client id" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: clientRow, error: loadErr } = await admin
    .from("clients")
    .select("id, organization_id")
    .eq("id", clientId)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ error: loadErr.message }, { status: 500 });
  }
  if (!clientRow) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const role = user.app_metadata?.role;
  const userOrgId = user.app_metadata?.organization_id;
  const isOwner = role === "owner";
  const isVA = role === "va";

  // Access + field whitelist derivation
  let allowedFields: (keyof PatchBody)[];
  if (isOwner) {
    if ((clientRow as { organization_id: string }).organization_id !== userOrgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    allowedFields = [...CLIENT_EDITABLE, ...OWNER_ONLY];
  } else if (isVA) {
    // VAs can update the client-editable subset on behalf of clients but
    // not persona/brand (owner-only).
    if ((clientRow as { organization_id: string }).organization_id !== userOrgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    allowedFields = [...CLIENT_EDITABLE];
  } else {
    // Client: must be linked via client_users.
    const { data: link } = await admin
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .eq("client_id", clientId)
      .maybeSingle();
    if (!link) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    allowedFields = [...CLIENT_EDITABLE];
  }

  // Reject attempts to set disallowed fields (explicit 403 instead of
  // silently dropping — users should know if something wasn't saved).
  const disallowed = (Object.keys(body) as (keyof PatchBody)[]).filter(
    (k) => body[k] !== undefined && !allowedFields.includes(k)
  );
  if (disallowed.length > 0) {
    return NextResponse.json(
      {
        error: `You do not have permission to update: ${disallowed.join(", ")}`,
      },
      { status: 403 }
    );
  }

  const update: Record<string, unknown> = {};

  const textFields = new Set<keyof PatchBody>([
    "notification_email",
    "phone_number",
    "persona_name",
    "persona_title",
    "persona_linkedin_url",
    "persona_photo_url",
    "brand_voice",
    "signature_block",
  ]);
  for (const key of allowedFields) {
    if (!textFields.has(key)) continue;
    const normalized = normalizeNullableText(body[key]);
    if (normalized !== undefined) update[key] = normalized;
  }

  if (allowedFields.includes("notification_cc_emails") && body.notification_cc_emails !== undefined) {
    const result = normalizeEmailArray(body.notification_cc_emails, MAX_CC_EMAILS);
    if (!Array.isArray(result)) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    update.notification_cc_emails = result;
  }

  if (allowedFields.includes("report_recipients") && body.report_recipients !== undefined) {
    if (body.report_recipients === null) {
      update.report_recipients = null;
    } else {
      const result = normalizeEmailArray(body.report_recipients, MAX_REPORT_RECIPIENTS);
      if (!Array.isArray(result)) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      update.report_recipients = result.length > 0 ? result : null;
    }
  }

  if (allowedFields.includes("report_interval_days") && body.report_interval_days !== undefined) {
    if (body.report_interval_days === null) {
      update.report_interval_days = null;
    } else if (
      typeof body.report_interval_days !== "number" ||
      !Number.isInteger(body.report_interval_days) ||
      body.report_interval_days < 1 ||
      body.report_interval_days > 90
    ) {
      return NextResponse.json(
        { error: "report_interval_days must be an integer between 1 and 90 (or null to disable)." },
        { status: 400 }
      );
    } else {
      update.report_interval_days = body.report_interval_days;
    }
  }

  // --- Real report schedule (the columns the send-reports cron actually reads).
  if (allowedFields.includes("report_frequency") && body.report_frequency !== undefined) {
    const freq = body.report_frequency;
    if (freq === null || freq === "" || freq === "off") {
      // Turning reports off clears the day fields too, matching the admin route.
      update.report_frequency = null;
      update.report_day_of_week = null;
      update.report_day_of_month = null;
    } else if (typeof freq === "string" && REPORT_FREQUENCIES.has(freq)) {
      update.report_frequency = freq;
    } else {
      return NextResponse.json(
        { error: `report_frequency must be one of weekly, biweekly, monthly (or null to turn off).` },
        { status: 400 }
      );
    }
  }

  if (allowedFields.includes("report_day_of_week") && body.report_day_of_week !== undefined) {
    if (body.report_day_of_week === null) {
      update.report_day_of_week = null;
    } else if (
      typeof body.report_day_of_week !== "number" ||
      !Number.isInteger(body.report_day_of_week) ||
      body.report_day_of_week < 0 ||
      body.report_day_of_week > 6
    ) {
      return NextResponse.json(
        { error: "report_day_of_week must be an integer 0-6 (Sunday=0), or null." },
        { status: 400 }
      );
    } else {
      update.report_day_of_week = body.report_day_of_week;
    }
  }

  if (allowedFields.includes("report_day_of_month") && body.report_day_of_month !== undefined) {
    if (body.report_day_of_month === null) {
      update.report_day_of_month = null;
    } else if (
      typeof body.report_day_of_month !== "number" ||
      !Number.isInteger(body.report_day_of_month) ||
      !((body.report_day_of_month >= 1 && body.report_day_of_month <= 28) || body.report_day_of_month === -1)
    ) {
      return NextResponse.json(
        { error: "report_day_of_month must be an integer 1-28, or -1 (last day of month), or null." },
        { status: 400 }
      );
    } else {
      update.report_day_of_month = body.report_day_of_month;
    }
  }

  if (allowedFields.includes("report_time_of_day") && body.report_time_of_day !== undefined) {
    const time = body.report_time_of_day;
    if (time === null || time === "") {
      update.report_time_of_day = null;
    } else if (typeof time === "string" && REPORT_TIME_RE.test(time)) {
      update.report_time_of_day = time;
    } else {
      return NextResponse.json(
        { error: "report_time_of_day must be 'HH:MM' (24-hour), or null." },
        { status: 400 }
      );
    }
  }

  if (allowedFields.includes("report_timezone") && body.report_timezone !== undefined) {
    const tz = body.report_timezone;
    if (tz === null || tz === "") {
      update.report_timezone = null;
    } else if (typeof tz === "string") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        update.report_timezone = tz;
      } catch {
        return NextResponse.json(
          { error: `report_timezone must be a valid IANA timezone (got '${tz}').` },
          { status: 400 }
        );
      }
    } else {
      return NextResponse.json(
        { error: "report_timezone must be a valid IANA timezone string, or null." },
        { status: 400 }
      );
    }
  }

  if (allowedFields.includes("report_schedule_start") && body.report_schedule_start !== undefined) {
    // Biweekly anchor: a real YYYY-MM-DD date, or null. Validated so a malformed
    // anchor can't quietly break the client's own cadence (NaN → always off-week).
    const anchor = body.report_schedule_start;
    if (anchor === null || anchor === "") {
      update.report_schedule_start = null;
    } else if (typeof anchor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(anchor) && !Number.isNaN(Date.parse(anchor))) {
      update.report_schedule_start = anchor;
    } else {
      return NextResponse.json(
        { error: "report_schedule_start must be a 'YYYY-MM-DD' date, or null." },
        { status: 400 }
      );
    }
  }

  if (allowedFields.includes("auto_notify_classes") && body.auto_notify_classes !== undefined) {
    if (!Array.isArray(body.auto_notify_classes)) {
      return NextResponse.json(
        { error: "auto_notify_classes must be an array" },
        { status: 400 }
      );
    }
    const invalid = body.auto_notify_classes.filter(
      (c) => !VALID_CLASSES.includes(c as ReplyClass)
    );
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid classes: ${invalid.join(", ")}` },
        { status: 400 }
      );
    }
    update.auto_notify_classes = Array.from(new Set(body.auto_notify_classes));
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  const { error: updateErr } = await admin
    .from("clients")
    .update(update)
    .eq("id", clientId);

  if (updateErr) {
    console.error("[clients/PATCH] update failed:", updateErr);
    return NextResponse.json({ error: "Failed to update client" }, { status: 500 });
  }

  return NextResponse.json({ success: true, updated_fields: Object.keys(update) });
}
