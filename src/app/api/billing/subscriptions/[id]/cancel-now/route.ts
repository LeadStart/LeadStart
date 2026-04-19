import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeDemoMode } from "@/lib/stripe/client";
import type { ClientSubscription } from "@/types/app";

/**
 * Immediate cancel — ends the subscription right now, no period-end grace.
 * Destructive: there is no pro-ration refund and the client loses access
 * immediately. Use the plain /cancel endpoint for the normal soft-cancel.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  void req;
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = (session.user as { app_metadata?: { role?: string } })
    .app_metadata?.role;
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: subRow } = await supabase
    .from("client_subscriptions")
    .select()
    .eq("id", id)
    .single();
  const sub = subRow as unknown as ClientSubscription | null;
  if (!sub) {
    return NextResponse.json(
      { error: "Subscription not found" },
      { status: 404 },
    );
  }
  if (sub.status === "canceled") {
    return NextResponse.json(
      { error: "Already canceled" },
      { status: 409 },
    );
  }

  if (!isStripeDemoMode() && sub.stripe_subscription_id) {
    try {
      await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stripe cancel failed";
      return NextResponse.json(
        { error: `Stripe cancel failed: ${msg}` },
        { status: 502 },
      );
    }
  }

  await supabase
    .from("client_subscriptions")
    .update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      cancel_at_period_end: false,
    } as Record<string, unknown>)
    .eq("id", id);

  return NextResponse.json({ ok: true, status: "canceled" });
}
