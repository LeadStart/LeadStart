// POST /api/admin/seed-inboxes/oauth/microsoft/start
//
// Begins the Microsoft seed connect flow (migration 00085). Owner-only. Mints
// a signed OAuth `state` (CSRF guard) and returns the Microsoft consent URL;
// the UI does a full-page navigation so the browser session survives the
// round-trip and lands back on the callback. 400 when the org hasn't saved its
// Microsoft OAuth app credentials yet.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/api-url";
import { loadMsOauthAppForOrg, msGraphClientForApp } from "@/lib/msgraph/org";
import { signOAuthState } from "@/lib/security/signed-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();
  const app = await loadMsOauthAppForOrg(admin, organizationId);
  if (!app) {
    return NextResponse.json(
      {
        error:
          "Add your Microsoft OAuth app (client ID + secret) under Settings → Integrations before connecting a Microsoft seed.",
      },
      { status: 400 },
    );
  }

  // Must be byte-identical to the redirect_uri the callback rebuilds (same
  // browser origin) and to what's registered in the Entra app.
  const redirectUri = new URL(
    appUrl("/api/admin/seed-inboxes/oauth/microsoft/callback"),
    req.nextUrl.origin,
  ).toString();

  const state = signOAuthState(organizationId, user.id);
  const url = msGraphClientForApp(app).buildAuthorizeUrl({ redirectUri, state });
  return NextResponse.json({ url });
}
