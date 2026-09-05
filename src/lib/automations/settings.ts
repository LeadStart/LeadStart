// Internal-automation settings: org-level notify config (migration 00087,
// organizations.automation_settings). The load/normalize/auth helpers behind
// the Settings → Integrations card and the delivery path in the reply pipeline.
//
// Mirrors the enrichment-settings helpers (src/lib/apify/auth.ts): a lenient
// normalizer that never throws (safe on read of a stored blob from any app
// version), a loader that falls back to defaults on a missing column/row, and
// an owner/VA auth gate. Secret masking for the read API lives here too so the
// route stays thin.

import { NextResponse } from "next/server";
import type { User, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationNotifyOn,
  type AutomationSettings,
  type AutomationSettingsStatus,
} from "@/types/app";

const NOTIFY_ON_VALUES: readonly AutomationNotifyOn[] = ["hot", "all_replies"];

/**
 * Coerce an arbitrary stored/posted blob into a complete AutomationSettings by
 * merging over `base` (defaults). Types only: never validates URL shape and
 * never throws, so a partial payload or an older/newer stored shape is safe.
 * String fields are trimmed; unknown keys are dropped.
 */
export function normalizeAutomationSettings(
  input: unknown,
  base: AutomationSettings = DEFAULT_AUTOMATION_SETTINGS,
): AutomationSettings {
  const o =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const bool = (v: unknown, fb: boolean): boolean =>
    typeof v === "boolean" ? v : fb;
  const str = (v: unknown, fb: string): string =>
    typeof v === "string" ? v.trim() : fb;
  const notifyOn = (v: unknown, fb: AutomationNotifyOn): AutomationNotifyOn =>
    typeof v === "string" && NOTIFY_ON_VALUES.includes(v as AutomationNotifyOn)
      ? (v as AutomationNotifyOn)
      : fb;
  return {
    enabled: bool(o.enabled, base.enabled),
    notify_on: notifyOn(o.notify_on, base.notify_on),
    slack_webhook_url: str(o.slack_webhook_url, base.slack_webhook_url),
    notify_email: str(o.notify_email, base.notify_email),
    outbound_webhook_url: str(o.outbound_webhook_url, base.outbound_webhook_url),
    outbound_webhook_secret: str(
      o.outbound_webhook_secret,
      base.outbound_webhook_secret,
    ),
  };
}

/**
 * Load an org's automation settings, merged over defaults. Never throws: a
 * missing column (migration 00087 not applied) or missing row yields defaults.
 */
export async function loadAutomationSettings(
  admin: SupabaseClient,
  organizationId: string,
): Promise<AutomationSettings> {
  const { data, error } = await admin
    .from("organizations")
    .select("automation_settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) return { ...DEFAULT_AUTOMATION_SETTINGS };
  return normalizeAutomationSettings(
    (data as { automation_settings?: unknown }).automation_settings,
  );
}

/** true when `s` looks like an http(s) URL. Used by the route for POST validation. */
export function isHttpUrl(s: string): boolean {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function urlHost(s: string): string | null {
  try {
    return new URL(s).host;
  } catch {
    return null;
  }
}

/**
 * Collapse settings into the masked read shape the settings card consumes:
 * non-secret config as values, the three secret-ish fields as booleans (plus a
 * host hint for the outbound webhook so the UI can show where it points).
 */
export function toAutomationStatus(
  s: AutomationSettings,
): AutomationSettingsStatus {
  return {
    enabled: s.enabled,
    notify_on: s.notify_on,
    notify_email: s.notify_email,
    slack_webhook_url_set: s.slack_webhook_url.length > 0,
    outbound_webhook_url_set: s.outbound_webhook_url.length > 0,
    outbound_webhook_url_host: s.outbound_webhook_url
      ? urlHost(s.outbound_webhook_url)
      : null,
    outbound_webhook_secret_set: s.outbound_webhook_secret.length > 0,
  };
}

/**
 * Owner/VA + org auth gate for the automation settings routes. Same shape as
 * requireEnrichmentContext (401 no user, 403 unless owner/va, 400 no org) minus
 * the Apify token.
 */
export async function requireAutomationContext(): Promise<
  | { error: NextResponse }
  | { user: User; organizationId: string; admin: SupabaseClient }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return {
      error: NextResponse.json(
        { error: "Owner or VA role required" },
        { status: 403 },
      ),
    };
  }

  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return {
      error: NextResponse.json({ error: "No organization on user" }, { status: 400 }),
    };
  }

  return { user, organizationId, admin: createAdminClient() };
}
