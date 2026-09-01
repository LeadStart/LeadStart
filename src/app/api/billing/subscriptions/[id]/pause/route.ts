import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, isStripeDemoMode } from "@/lib/stripe/client";
import type { ClientSubscription } from "@/types/app";

interface Body {
  action: "pause" | "resume";
}

/**
 * Pause or resume collection on a subscription.
 *
 *  - "pause"  → Stripe won't attempt to charge the card when the next invoice
 *               is finalized. Existing draft invoices are voided. Client keeps
 *               access (if you want to end access too, cancel instead).
 *  - "resume" → Clears pause_collection, Stripe resumes normal billing.
 *
 * The subscription status in Stripe stays "active" while paused — Stripe
 * signals pause via the `pause_collection` field, not status. We mirror that
 * state in our DB by setting our own `status = "paused"` and relying on the
 * webhook handler to keep it in sync (see webhooks.ts).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Partial<Body>;
  const action = body.action;
  if (action !== "pause" && action !== "resume") {
    return NextResponse.json(
      { error: "action must be 'pause' or 'resume'" },
      { status: 400 },
    );
  }

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
      { error: "Canceled subscriptions cannot be paused or resumed" },
      { status: 409 },
    );
  }

  if (!isStripeDemoMode() && sub.stripe_subscription_id) {
    try {
      if (action === "pause") {
        await getStripe().subscriptions.update(sub.stripe_subscription_id, {
          pause_collection: { behavior: "void" },
        });
      } else {
        await getStripe().subscriptions.update(sub.stripe_subscription_id, {
          pause_collection: "",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stripe update failed";
      return NextResponse.json(
        { error: `Stripe ${action} failed: ${msg}` },
        { status: 502 },
      );
    }
  }

  // Mirror via the service-role client: client_subscriptions is service-role-only
  // under the hardened RLS (00100), so a user-client update is silently denied.
  // Non-fatal — Stripe already applied the change and the webhook confirms it.
  const admin = createAdminClient();
  const { error: mirrorErr } = await admin
    .from("client_subscriptions")
    .update({
      status: action === "pause" ? "paused" : "active",
    } as Record<string, unknown>)
    .eq("id", id);
  if (mirrorErr) console.error("Subscription mirror update failed:", mirrorErr);

  return NextResponse.json({
    ok: true,
    status: action === "pause" ? "paused" : "active",
  });
}
