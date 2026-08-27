import { NextRequest, NextResponse } from "next/server";
import {
  loadAutomationSettings,
  normalizeAutomationSettings,
  requireAutomationContext,
  toAutomationStatus,
  isHttpUrl,
} from "@/lib/automations/settings";
import type { AutomationSettings } from "@/types/app";

// GET/POST /api/admin/automations/settings — read + write the org's internal-
// automation notify config (organizations.automation_settings, migration 00087).
//
// GET returns a MASKED status: non-secret config as values, the three secret-ish
// fields (Slack URL, outbound webhook URL, webhook secret) collapsed to booleans
// (+ a host hint for the webhook). Secrets are never echoed to the browser.
//
// POST body: { settings: Partial<...> }. Merged over CURRENT stored settings so
// a partial payload never wipes other keys. Secret fields follow the ms-oauth
// convention: a non-empty value overwrites; blank/omitted keeps the stored one;
// an explicit clear_* flag nulls it. Owner/VA gate.

export const maxDuration = 15;

export async function GET() {
  const ctx = await requireAutomationContext();
  if ("error" in ctx) return ctx.error;
  const settings = await loadAutomationSettings(ctx.admin, ctx.organizationId);
  return NextResponse.json({ status: toAutomationStatus(settings) });
}

interface AutomationPostBody {
  settings?: {
    enabled?: unknown;
    notify_on?: unknown;
    notify_email?: unknown;
    slack_webhook_url?: unknown;
    outbound_webhook_url?: unknown;
    outbound_webhook_secret?: unknown;
    clear_slack?: unknown;
    clear_outbound_webhook?: unknown;
    clear_outbound_secret?: unknown;
  };
}

export async function POST(request: NextRequest) {
  const ctx = await requireAutomationContext();
  if ("error" in ctx) return ctx.error;
  const { admin, organizationId } = ctx;

  const body = (await request.json().catch(() => null)) as AutomationPostBody | null;
  if (!body || typeof body.settings !== "object" || body.settings === null) {
    return NextResponse.json({ error: "Body must be { settings: { ... } }" }, { status: 400 });
  }
  const s = body.settings;

  const current = await loadAutomationSettings(admin, organizationId);

  // Merge non-secret fields (apply only when provided).
  const merged: AutomationSettings = { ...current };
  if (typeof s.enabled === "boolean") merged.enabled = s.enabled;
  if (typeof s.notify_on === "string") merged.notify_on = s.notify_on as AutomationSettings["notify_on"];
  if (typeof s.notify_email === "string") merged.notify_email = s.notify_email.trim();

  // Secret fields: clear flag wins; else non-empty string overwrites; else keep.
  const applySecret = (
    provided: unknown,
    clear: unknown,
    keep: string,
  ): string => {
    if (clear === true) return "";
    if (typeof provided === "string" && provided.trim() !== "") return provided.trim();
    return keep;
  };
  merged.slack_webhook_url = applySecret(s.slack_webhook_url, s.clear_slack, current.slack_webhook_url);
  merged.outbound_webhook_url = applySecret(
    s.outbound_webhook_url,
    s.clear_outbound_webhook,
    current.outbound_webhook_url,
  );
  // Clearing the webhook URL also clears its secret (a signature with no target
  // is meaningless).
  merged.outbound_webhook_secret = applySecret(
    s.outbound_webhook_secret,
    s.clear_outbound_secret === true || s.clear_outbound_webhook === true,
    current.outbound_webhook_secret,
  );

  // Validate the URL-shaped fields so a typo surfaces here instead of silently
  // never delivering.
  if (merged.slack_webhook_url && !isHttpUrl(merged.slack_webhook_url)) {
    return NextResponse.json(
      { error: "Slack webhook URL must be a valid https:// URL." },
      { status: 400 },
    );
  }
  if (merged.outbound_webhook_url && !isHttpUrl(merged.outbound_webhook_url)) {
    return NextResponse.json(
      { error: "Outbound webhook URL must be a valid https:// URL." },
      { status: 400 },
    );
  }
  if (merged.notify_email && !merged.notify_email.includes("@")) {
    return NextResponse.json(
      { error: "Notify email must be a valid address." },
      { status: 400 },
    );
  }

  const next = normalizeAutomationSettings(merged);
  const { error } = await admin
    .from("organizations")
    .update({ automation_settings: next })
    .eq("id", organizationId);
  if (error) {
    // e.g. migration 00087 not applied yet — surface instead of claiming saved.
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: toAutomationStatus(next) });
}
