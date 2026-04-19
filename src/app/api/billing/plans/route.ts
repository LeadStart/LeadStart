import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncPlanToStripe } from "@/lib/stripe/helpers";
import type { PricingPlan } from "@/types/app";

interface CreatePlanBody {
  name?: string;
  description?: string | null;
  features?: string[];
  monthly_price_cents?: number;
  scope_template?: string | null;
  active?: boolean;
  currency?: string;
  slug?: string;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 48) || "plan"
  );
}

/**
 * Create a new pricing plan and sync it to Stripe as a Product + recurring
 * Price. Owner-only. Sort order is max+1 within the org so the new plan
 * lands at the end of the Plans tab.
 */
export async function POST(req: NextRequest) {
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
  const organizationId = (
    session.user as { app_metadata?: { organization_id?: string } }
  ).app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json(
      { error: "Missing organization on session" },
      { status: 400 },
    );
  }

  const body = (await req.json()) as CreatePlanBody;
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const monthlyCents =
    typeof body.monthly_price_cents === "number" &&
    body.monthly_price_cents >= 0
      ? Math.round(body.monthly_price_cents)
      : 0;

  // Unique slug within the org — base on provided or derived, then suffix
  // -2, -3, … if taken.
  const baseSlug = slugify(body.slug || name);
  const { data: existingRows } = await supabase
    .from("pricing_plans")
    .select("slug, sort_order")
    .eq("organization_id", organizationId);
  const existing = (existingRows as Array<{
    slug: string;
    sort_order: number | null;
  }> | null) ?? [];
  const takenSlugs = new Set(existing.map((r) => r.slug));
  let slug = baseSlug;
  for (let i = 2; takenSlugs.has(slug); i++) {
    slug = `${baseSlug}-${i}`;
  }
  const nextSortOrder =
    (existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) || 0) + 1;

  const now = new Date().toISOString();
  const draft: PricingPlan = {
    id: `plan-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    organization_id: organizationId,
    slug,
    name,
    description: body.description ?? null,
    features: Array.isArray(body.features)
      ? body.features.filter((f) => typeof f === "string" && f.trim().length > 0)
      : [],
    monthly_price_cents: monthlyCents,
    currency: body.currency || "usd",
    stripe_product_id: null,
    stripe_monthly_price_id: null,
    scope_template: body.scope_template ?? null,
    active: body.active !== false,
    sort_order: nextSortOrder,
    created_at: now,
    updated_at: now,
  };

  let stripeIds;
  try {
    stripeIds = await syncPlanToStripe(draft, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe sync failed";
    return NextResponse.json(
      { error: `Stripe sync failed: ${msg}` },
      { status: 502 },
    );
  }

  const insertRow: PricingPlan = {
    ...draft,
    stripe_product_id: stripeIds.stripe_product_id,
    stripe_monthly_price_id: stripeIds.stripe_monthly_price_id,
  };

  const { data: inserted } = await supabase
    .from("pricing_plans")
    .insert(insertRow as unknown as Record<string, unknown>);
  const plan =
    (inserted as unknown as PricingPlan[] | null)?.[0] ?? insertRow;

  return NextResponse.json({ plan, stripe: stripeIds });
}
