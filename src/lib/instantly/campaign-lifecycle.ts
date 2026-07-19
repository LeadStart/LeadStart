import type { SupabaseClient } from "@supabase/supabase-js";
import { InstantlyClient } from "./client";

// Drive an Instantly campaign's state from LeadStart.
//
// For source_channel='instantly' campaigns the actual sending lives on
// Instantly's side, so a local status flip alone wouldn't stop/start sends —
// we must call Instantly's API. 'activate' covers both start and resume per
// Instantly's docs. Returns ok, or an error + HTTP status for the caller to
// surface. The caller should only mirror the status locally on { ok: true }.
export async function controlInstantlyCampaign(
  admin: SupabaseClient,
  organizationId: string,
  instantlyCampaignId: string | null,
  action: "pause" | "activate",
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!instantlyCampaignId) {
    return {
      ok: false,
      status: 400,
      error:
        "This Instantly campaign isn't linked yet (no Instantly campaign id). Sync it from Settings first.",
    };
  }

  const { data: org } = await admin
    .from("organizations")
    .select("instantly_api_key")
    .eq("id", organizationId)
    .maybeSingle();
  const apiKey =
    (org as { instantly_api_key: string | null } | null)?.instantly_api_key ||
    process.env.INSTANTLY_API_KEY ||
    "";
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "Instantly API key not set. Save it in /admin/settings/api first.",
    };
  }

  try {
    const client = new InstantlyClient(apiKey);
    if (action === "pause") {
      await client.pauseCampaign(instantlyCampaignId);
    } else {
      await client.activateCampaign(instantlyCampaignId);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      error: `Instantly rejected the ${action}: ${message}`,
    };
  }
}
