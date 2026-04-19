import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncPlanToStripe } from "@/lib/stripe/helpers";
import type { PricingPlan } from "@/types/app";

const ALLOWED_FIELDS: Array<keyof PricingPlan> = [
  "name",
  "description",
  "features",
  "monthly_price_cents",
  "scope_template",
  "active",
  "sort_order",
];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const body = (await req.json()) as Partial<PricingPlan>;

  // Whitelist fields; reject anything outside the allowed set.
  const updates: Partial<PricingPlan> = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in body) {
      (updates as Record<string, unknown>)[key] = body[key];
    }
  }

  const { data: currentRow } = await supabase
    .from("pricing_plans")
    .select()
    .eq("id", id)
    .single();
  if (!currentRow) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  const current = currentRow as unknown as PricingPlan;

  let stripeIds;
  try {
    stripeIds = await syncPlanToStripe(current, updates);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe sync failed";
    return NextResponse.json(
      { error: `Stripe sync failed: ${msg}` },
      { status: 502 },
    );
  }

  const { data: updated } = await supabase
    .from("pricing_plans")
    .update({
      ...updates,
      stripe_product_id: stripeIds.stripe_product_id,
      stripe_monthly_price_id: stripeIds.stripe_monthly_price_id,
    } as Record<string, unknown>)
    .eq("id", id);

  const plan = (updated as unknown as PricingPlan[] | null)?.[0] ?? {
    ...current,
    ...updates,
    stripe_product_id: stripeIds.stripe_product_id,
    stripe_monthly_price_id: stripeIds.stripe_monthly_price_id,
  };

  return NextResponse.json({
    plan,
    stripe: stripeIds,
  });
}
