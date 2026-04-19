import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
 *
 * In demo mode this routes through the demo Supabase client, which serves the
 * MOCK_* arrays — so the page behaves identically locally and in prod (empty
 * DB → empty tabs, no ghost mock rows).
 */
export async function GET() {
  const supabase = await createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = (session.user as { app_metadata?: { role?: string } })
    .app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const organizationId = (
    session.user as { app_metadata?: { organization_id?: string } }
  ).app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Missing organization on session" },
      { status: 400 },
    );
  }

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

  return NextResponse.json({
    plans: (plansRes.data as unknown as PricingPlan[] | null) ?? [],
    quotes: (quotesRes.data as unknown as Quote[] | null) ?? [],
    subscriptions:
      (subsRes.data as unknown as ClientSubscription[] | null) ?? [],
    invoices: (invoicesRes.data as unknown as BillingInvoice[] | null) ?? [],
    clients: (clientsRes.data as unknown as Client[] | null) ?? [],
  });
}
