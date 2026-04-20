import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isStripeDemoMode, isStripeLiveMode } from "@/lib/stripe/client";
import type {
  BillingInvoice,
  Client,
  ClientSubscription,
  PricingPlan,
  Quote,
} from "@/types/app";

/**
 * Hydrates the admin billing page with everything it needs in one round-trip:
 * plans, quotes, subscriptions, invoices, clients. All scoped to the caller's
 * organization_id.
 */
export async function GET() {
  // Middleware already resolved identity and forwarded it via headers, so we
  // skip the second Supabase auth round-trip that used to live here.
  const h = await headers();
  const userId = h.get("x-user-id");
  const role = h.get("x-user-role");
  const organizationId = h.get("x-user-org");

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!organizationId) {
    return NextResponse.json(
      { error: "Missing organization on session" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  const [plansRes, quotesRes, subsRes, invoicesRes, clientsRes] =
    await Promise.all([
      supabase
        .from("pricing_plans")
        .select()
        .eq("organization_id", organizationId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("quotes")
        .select()
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_subscriptions")
        .select()
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false }),
      supabase
        .from("billing_invoices")
        .select()
        .eq("organization_id", organizationId)
        .order("issued_at", { ascending: false }),
      supabase
        .from("clients")
        .select()
        .eq("organization_id", organizationId)
        .order("name", { ascending: true }),
    ]);

  const stripeMode: "demo" | "live" | "test" = isStripeDemoMode()
    ? "demo"
    : isStripeLiveMode()
      ? "live"
      : "test";

  return NextResponse.json({
    plans: (plansRes.data as unknown as PricingPlan[] | null) ?? [],
    quotes: (quotesRes.data as unknown as Quote[] | null) ?? [],
    subscriptions:
      (subsRes.data as unknown as ClientSubscription[] | null) ?? [],
    invoices: (invoicesRes.data as unknown as BillingInvoice[] | null) ?? [],
    clients: (clientsRes.data as unknown as Client[] | null) ?? [],
    stripe_mode: stripeMode,
  });
}
