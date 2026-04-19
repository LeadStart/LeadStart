import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeDemoMode } from "@/lib/stripe/client";
import { handleStripeEvent } from "@/lib/stripe/webhooks";

/**
 * Stripe webhook receiver.
 *
 * Flow:
 *  1. Read raw body (required for signature verification — DO NOT JSON.parse first).
 *  2. Verify signature against STRIPE_WEBHOOK_SECRET (skipped in demo mode so fixtures can be POSTed directly).
 *  3. Dedupe on `stripe_events.stripe_event_id` — Stripe retries, so idempotency is mandatory.
 *  4. Insert event row, dispatch to handler, and on failure record the error so Stripe will retry.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let event: Stripe.Event;
  if (isStripeDemoMode()) {
    // Demo / local testing: accept raw JSON so fixture files can be POSTed
    // with `curl -d @scripts/fixtures/stripe-*.json`.
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }
  } else {
    const signature = req.headers.get("stripe-signature");
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!signature) {
      return NextResponse.json(
        { error: "Missing Stripe-Signature header" },
        { status: 400 },
      );
    }
    if (!secret) {
      return NextResponse.json(
        { error: "STRIPE_WEBHOOK_SECRET not configured" },
        { status: 500 },
      );
    }
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid signature";
      return NextResponse.json(
        { error: `Signature verification failed: ${msg}` },
        { status: 400 },
      );
    }
  }

  if (!event.id || !event.type) {
    return NextResponse.json({ error: "Malformed event" }, { status: 400 });
  }

  const supabase = await createClient();

  // Idempotency: if we've already processed this event, return 200 silently
  // so Stripe stops retrying.
  const { data: existing } = await supabase
    .from("stripe_events")
    .select("stripe_event_id")
    .eq("stripe_event_id", event.id)
    .single();
  if (existing) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // Record the event row up front so we have a trace even if the handler
  // throws. `error` column is populated on handler failure below.
  await supabase.from("stripe_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    processed_at: new Date().toISOString(),
    payload: event as unknown as Record<string, unknown>,
  } as Record<string, unknown>);

  try {
    await handleStripeEvent(event, supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Handler failed";
    await supabase
      .from("stripe_events")
      .update({ error: msg } as Record<string, unknown>)
      .eq("stripe_event_id", event.id);
    // 500 so Stripe retries. Signature + dedupe are both already satisfied.
    return NextResponse.json(
      { error: `Handler failed: ${msg}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
