// POST /api/admin/millionverifier/test — validate a Million Verifier API key by
// fetching its credit balance. Owner-only.
//
// We deliberately do NOT copy the no-auth /prospecting/validate-key precedent:
// a key probe that anyone could hammer with bad keys is exactly the vector that
// gets this server's (shared Vercel) IP blocked. Owner-gating keeps it safe.
//
// Body: { api_key: string }
// Returns 200 { success: true, credits } on a working key, 400 { error } with a
// human message otherwise. When the tested key matches the org's saved key we
// also refresh the cached balance and clear any stored error state, so a
// corrected key is retried by the send cron on its very next tick.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MillionVerifierClient, MillionVerifierError } from "@/lib/millionverifier/client";

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
    const credits = await new MillionVerifierClient(key).credits();

    // If this is the org's currently-saved key, refresh the cached balance and
    // clear any error/suppression state so the next cron tick calls again.
    const orgId = user.app_metadata?.organization_id as string | undefined;
    if (orgId) {
      const admin = createAdminClient();
      const { data: org } = await admin
        .from("organizations")
        .select("millionverifier_api_key")
        .eq("id", orgId)
        .maybeSingle();
      const savedKey =
        (org as { millionverifier_api_key: string | null } | null)?.millionverifier_api_key ?? null;
      if (savedKey && savedKey.trim() === key) {
        await admin
          .from("organizations")
          .update({
            millionverifier_credits: credits,
            millionverifier_credits_checked_at: new Date().toISOString(),
            millionverifier_last_error: null,
            millionverifier_last_error_kind: null,
            millionverifier_last_error_at: null,
            millionverifier_error_streak: 0,
          })
          .eq("id", orgId);
      }
    }

    return NextResponse.json({ success: true, credits });
  } catch (err) {
    const message =
      err instanceof MillionVerifierError
        ? err.kind === "credits"
          ? "This key has no verification credits left."
          : err.kind === "blocked"
            ? "This server's IP is blocked by Million Verifier — contact their support."
            : err.kind === "auth"
              ? "Million Verifier rejected this API key."
              : "Couldn't reach Million Verifier — try again."
        : err instanceof Error
          ? err.message
          : "Verification test failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
