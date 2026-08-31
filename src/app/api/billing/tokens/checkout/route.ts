// POST /api/billing/tokens/checkout — buyer starts a token-pack purchase.
//
// Buyer-authenticated. Validates the requested pack is active + priced, then
// creates a hosted Stripe Checkout session (data-driven from token_packs) and
// returns its URL for the client to redirect to. The webhook credits the ledger
// on payment. Until a pack has a price set, it is not purchasable (400).

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createTokenPackCheckoutSession } from "@/lib/stripe/helpers";

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "buyer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on account" }, { status: 400 });
  }

  let body: { pack_id?: string };
  try {
    body = (await req.json()) as { pack_id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const packId = body.pack_id;
  if (!packId) {
    return NextResponse.json({ error: "pack_id required" }, { status: 400 });
  }

  // Load the pack via the service-role client (token_packs isn't buyer-writable,
  // and we trust the DB copy of price/tokens, never a client-supplied amount).
  const admin = createAdminClient();
  const { data: pack, error: packErr } = await admin
    .from("token_packs")
    .select("id, name, tokens, price_usd, active")
    .eq("id", packId)
    .maybeSingle();

  if (packErr) {
    return NextResponse.json({ error: "Could not load pack" }, { status: 500 });
  }
  const p = pack as
    | { id: string; name: string; tokens: number; price_usd: number | null; active: boolean }
    | null;
  if (!p || !p.active || p.price_usd == null || p.price_usd <= 0) {
    return NextResponse.json(
      { error: "This token pack isn't available for purchase yet." },
      { status: 400 },
    );
  }

  const result = await createTokenPackCheckoutSession({
    pack: { id: p.id, name: p.name, tokens: p.tokens, price_usd: p.price_usd },
    organizationId,
    buyerEmail: user.email ?? null,
    origin: req.nextUrl.origin,
  });

  if (!result.url) {
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
  return NextResponse.json({ url: result.url, demo: result.demo });
}
