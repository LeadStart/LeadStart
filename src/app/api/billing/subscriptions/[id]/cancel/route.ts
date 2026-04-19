import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeDemoMode } from "@/lib/stripe/client";
import type { ClientSubscription } from "@/types/app";

/**
 * Admin cancel — schedules the subscription to cancel at the end of the
 * current period (per decision #7: no pro-ration, service runs until period
 * end). Reversible: Stripe allows re-activating by setting
 * `cancel_at_period_end: false` again before the period ends.
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

  // Tell Stripe first, then mirror the flag. Webhook will confirm state.
  if (!isStripeDemoMode() && sub.stripe_subscription_id) {
    try {
      await getStripe().subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stripe update failed";
      return NextResponse.json(
        { error: `Stripe cancel failed: ${msg}` },
        { status: 502 },
      );
    }
  }

  await supabase
    .from("client_subscriptions")
    .update({ cancel_at_period_end: true } as Record<string, unknown>)
    .eq("id", id);

  return NextResponse.json({
    ok: true,
    cancel_at_period_end: true,
    current_period_end: sub.current_period_end,
  });
}
