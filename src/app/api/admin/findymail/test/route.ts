// POST /api/admin/findymail/test: validate a Findymail API key by fetching its
// remaining finder credits. Owner-only (same rationale as the Million Verifier
// test route: an unauthenticated key probe is an IP-block / abuse vector).
//
// Body: { api_key: string }
// Returns 200 { success: true, credits } on a working key, 400 { error } with a
// human message otherwise. When the tested key matches the org's saved key we
// also refresh the cached balance so the settings card shows a current number.
//
// NOTE: the finder itself (used by the enrichment recovery step) works off the
// saved key regardless of this test: a failed test never blocks saving or using
// the key, it just means the credit readout couldn't be fetched.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FindymailClient, FindymailError } from "@/lib/findymail/client";

interface TestBody {
  api_key?: string;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "api_key is required" }, { status: 400 });
  }

  try {
    const credits = await new FindymailClient(key).remainingCredits();

    const orgId = user.app_metadata?.organization_id as string | undefined;
    if (orgId) {
      const admin = createAdminClient();
      const { data: org } = await admin
        .from("organizations")
        .select("findymail_api_key")
        .eq("id", orgId)
        .maybeSingle();
      const savedKey =
        (org as { findymail_api_key: string | null } | null)?.findymail_api_key ?? null;
      if (savedKey && savedKey.trim() === key) {
        await admin
          .from("organizations")
          .update({
            findymail_credits: credits,
            findymail_credits_checked_at: new Date().toISOString(),
          })
          .eq("id", orgId);
      }
    }

    return NextResponse.json({ success: true, credits });
  } catch (err) {
    const message =
      err instanceof FindymailError
        ? err.kind === "credits"
          ? "This Findymail key has no finder credits left."
          : err.kind === "auth"
            ? "Findymail rejected this API key."
            : "Couldn't reach Findymail, try again."
        : err instanceof Error
          ? err.message
          : "Findymail test failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
