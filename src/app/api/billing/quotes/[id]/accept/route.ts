import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createCheckoutSessionForQuote } from "@/lib/stripe/helpers";
import type { Client, PricingPlan, Quote } from "@/types/app";

/**
 * Public endpoint: recipient clicks "Accept & pay" on the hosted quote page.
 * Verifies the signed URL hash, gates on quote state, creates a Stripe
 * Checkout session (or demo fake), records the acceptance audit trail, and
 * returns the checkout URL for the client to redirect to.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json()) as {
    token?: string;
    accepted_by_email?: string;
  };
  const token = body.token;
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: quoteRow } = await supabase
    .from("quotes")
    .select()
    .eq("id", id)
    .single();
  const quote = quoteRow as unknown as Quote | null;
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (quote.signed_url_hash !== token) {
    return NextResponse.json({ error: "Invalid token" }, { status: 403 });
  }

  // State gate
  if (quote.status === "draft") {
    return NextResponse.json(
      { error: "Quote is not sendable yet" },
      { status: 409 },
    );
  }
  if (quote.status === "accepted") {
    return NextResponse.json(
      { error: "Already accepted" },
      { status: 409 },
    );
  }
  if (quote.status === "declined" || quote.status === "canceled") {
    return NextResponse.json(
      { error: "Quote no longer active" },
      { status: 409 },
    );
  }
  if (quote.expires_at && new Date(quote.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "Quote has expired" }, { status: 409 });
  }

  // Load client + plan for the Checkout session
  const { data: clientRow } = await supabase
    .from("clients")
    .select()
    .eq("id", quote.client_id)
    .single();
  const client = clientRow as unknown as Client | null;
  if (!client) {
    return NextResponse.json({ error: "Client missing" }, { status: 500 });
  }

  let plan: PricingPlan | null = null;
  if (quote.plan_id) {
    const { data: planRow } = await supabase
      .from("pricing_plans")
      .select()
      .eq("id", quote.plan_id)
      .single();
    plan = (planRow as unknown as PricingPlan | null) ?? null;
  }

  const origin = req.nextUrl.origin;
  let session;
  try {
    session = await createCheckoutSessionForQuote({
      quote,
      client,
      plan,
      origin,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Checkout create failed";
    return NextResponse.json(
      { error: `Checkout create failed: ${msg}` },
      { status: 502 },
    );
  }

  const now = new Date().toISOString();
  const forwardedFor = req.headers.get("x-forwarded-for");
  const ip = forwardedFor ? forwardedFor.split(",")[0].trim() : null;
  const userAgent = req.headers.get("user-agent");

  await supabase
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accepted_by_email:
        body.accepted_by_email || quote.sent_to_email || null,
      accepted_ip: ip,
      accepted_user_agent: userAgent,
      stripe_checkout_session_id: session.session_id,
    } as Record<string, unknown>)
    .eq("id", id);

  // Persist the Stripe Customer id on the client for upsells + portal links.
  if (session.customer_id && !client.stripe_customer_id) {
    await supabase
      .from("clients")
      .update({ stripe_customer_id: session.customer_id } as Record<
        string,
        unknown
      >)
      .eq("id", client.id);
  }

  // Track the Checkout session row for admin visibility + webhook correlation.
  await supabase.from("payment_links").insert({
    id: randomUUID(),
    organization_id: client.organization_id,
    client_id: client.id,
    quote_id: quote.id,
    stripe_checkout_session_id: session.session_id,
    stripe_checkout_url: session.checkout_url,
    status: "pending",
    created_at: now,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    completed_at: null,
  } as Record<string, unknown>);

  return NextResponse.json({
    checkout_url: session.checkout_url,
    session_id: session.session_id,
  });
}
