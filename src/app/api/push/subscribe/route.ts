import { NextResponse } from "next/server";
import { getForwardedIdentity } from "@/lib/security/identity";
import { createClient } from "@/lib/supabase/server";

// Save (upsert) a web-push subscription for the signed-in user. Runs behind the
// auth middleware, so getForwardedIdentity() gives us the user + org without a
// second round-trip. RLS scopes the write to the user's own rows.
export async function POST(request: Request) {
  const identity = await getForwardedIdentity();
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json(
      { error: "Missing subscription fields" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: identity.userId,
      organization_id: identity.organizationId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    console.error("[push/subscribe] upsert failed:", error);
    return NextResponse.json(
      { error: "Could not save subscription" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
