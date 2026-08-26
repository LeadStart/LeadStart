// GET /api/admin/seed-inboxes/oauth/microsoft/callback
//
// Completes the Microsoft seed connect flow (migration 00085). Browser-facing:
// EVERY outcome is a redirect back to Admin → Mailboxes with ?seed=connected
// or ?seed=failed&reason=... (never JSON). Security: a live owner session whose
// org matches the signed `state` (the CSRF guard), then exchange → identify →
// upsert the seed with its rotated refresh token.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/api-url";
import { loadMsOauthAppForOrg, msGraphClientForApp } from "@/lib/msgraph/org";
import { verifyOAuthState } from "@/lib/security/signed-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(req: NextRequest, reason: string): NextResponse {
  return NextResponse.redirect(
    new URL(appUrl(`/admin/mailboxes?seed=failed&reason=${reason}`), req.nextUrl.origin),
  );
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  // The user declined consent (or Entra returned an error).
  if (params.get("error")) return fail(req, "denied");

  const code = params.get("code");
  const state = params.get("state");
  if (!code) return fail(req, "missing_code");
  if (!state) return fail(req, "bad_state");

  // Live owner session.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const organizationId = user?.app_metadata?.organization_id as string | undefined;
  if (!user || user.app_metadata?.role !== "owner" || !organizationId) {
    return fail(req, "forbidden");
  }

  // Signed state must verify AND bind to this owner's org.
  const verified = verifyOAuthState(state);
  if (!verified || verified.orgId !== organizationId) return fail(req, "bad_state");

  const admin = createAdminClient();
  const app = await loadMsOauthAppForOrg(admin, organizationId);
  if (!app) return fail(req, "token_exchange_failed");

  const graph = msGraphClientForApp(app);
  const redirectUri = new URL(
    appUrl("/api/admin/seed-inboxes/oauth/microsoft/callback"),
    req.nextUrl.origin,
  ).toString();

  // Exchange the code.
  let tokens;
  try {
    tokens = await graph.exchangeCode({ code, redirectUri });
  } catch {
    return fail(req, "token_exchange_failed");
  }

  // Identify which mailbox was connected.
  let email: string;
  try {
    email = (await graph.me(tokens.accessToken)).email;
  } catch {
    return fail(req, "profile_failed");
  }

  // Upsert the seed. label/role are omitted so a RECONNECT preserves whatever
  // the owner set previously; status/error reset so a benched seed heals.
  const { error } = await admin.from("seed_inboxes").upsert(
    {
      organization_id: organizationId,
      email_address: email,
      provider: "microsoft_graph",
      auth: { refresh_token: tokens.refreshToken, connected_at: new Date().toISOString() },
      status: "active",
      last_error: null,
      last_error_at: null,
    },
    { onConflict: "organization_id,email_address" },
  );
  if (error) return fail(req, "save_failed");

  return NextResponse.redirect(
    new URL(appUrl("/admin/mailboxes?seed=connected"), req.nextUrl.origin),
  );
}
