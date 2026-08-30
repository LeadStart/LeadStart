import { NextResponse } from "next/server";
import { getForwardedIdentity } from "@/lib/security/identity";
import { createClient } from "@/lib/supabase/server";

// Remove a web-push subscription (the user turned notifications off, or the
// browser rotated the endpoint). RLS scopes the delete to the user's own rows.
export async function POST(request: Request) {
  const identity = await getForwardedIdentity();
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", body.endpoint);

  if (error) {
    console.error("[push/unsubscribe] delete failed:", error);
    return NextResponse.json(
      { error: "Could not remove subscription" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
