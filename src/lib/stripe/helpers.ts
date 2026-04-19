import "server-only";
import { appUrl } from "@/lib/api-url";
import type { Client, PricingPlan, Quote } from "@/types/app";
import { getStripe, isStripeDemoMode } from "./client";

export interface PlanStripeIds {
  stripe_product_id: string;
  stripe_monthly_price_id: string;
  /** If a price change forced us to archive the old price, this is its id. */
  archived_price_id: string | null;
}

/**
 * Sync a plan's state to Stripe: creates the Product + recurring Price on
 * first save, archives-and-replaces Price when the monthly amount changes,
 * and mirrors `active` onto the Product.
 *
 * Stripe Prices are immutable (amount / currency / recurring cadence cannot
 * be edited), so the archive-and-replace pattern is required. Existing
 * subscriptions stay on their original price — Stripe default behavior —
 * until explicitly migrated. The admin UI surfaces this to avoid surprise.
 *
 * In demo mode, returns deterministic fake IDs so the UI can exercise the
 * full flow without real keys.
 */
export async function syncPlanToStripe(
  current: PricingPlan,
  updates: Partial<PricingPlan>,
): Promise<PlanStripeIds> {
  const target: PricingPlan = { ...current, ...updates };

  const priceChanged =
    current.stripe_monthly_price_id == null ||
    target.monthly_price_cents !== current.monthly_price_cents ||
    target.currency !== current.currency;

  if (isStripeDemoMode()) {
    const productId =
      current.stripe_product_id || `prod_demo_${target.slug}`;
    const priceId = priceChanged
      ? `price_demo_${target.slug}_${target.monthly_price_cents}`
      : current.stripe_monthly_price_id!;
    return {
      stripe_product_id: productId,
      stripe_monthly_price_id: priceId,
      archived_price_id:
        priceChanged && current.stripe_monthly_price_id
          ? current.stripe_monthly_price_id
          : null,
    };
  }

  const stripe = getStripe();

  // Product: create first time, update name/description/active thereafter.
  let productId = current.stripe_product_id;
  if (!productId) {
    const product = await stripe.products.create(
      {
        name: target.name,
        description: target.description ?? undefined,
        active: target.active,
        metadata: {
          plan_id: target.id,
          plan_slug: target.slug,
          organization_id: target.organization_id,
        },
      },
      { idempotencyKey: `plan_product_create_${target.id}` },
    );
    productId = product.id;
  } else {
    await stripe.products.update(productId, {
      name: target.name,
      description: target.description ?? undefined,
      active: target.active,
    });
  }

  // Price: archive old when it changes, always create a new one.
  let priceId = current.stripe_monthly_price_id;
  let archivedPriceId: string | null = null;

  if (priceChanged) {
    if (current.stripe_monthly_price_id) {
      await stripe.prices.update(current.stripe_monthly_price_id, {
        active: false,
      });
      archivedPriceId = current.stripe_monthly_price_id;
    }
    const created = await stripe.prices.create(
      {
        product: productId,
        currency: target.currency,
        unit_amount: target.monthly_price_cents,
        recurring: { interval: "month" },
        nickname: `${target.name} — monthly`,
        metadata: {
          plan_id: target.id,
          plan_slug: target.slug,
        },
      },
      {
        idempotencyKey: `plan_price_create_${target.id}_${target.monthly_price_cents}`,
      },
    );
    priceId = created.id;
  }

  return {
    stripe_product_id: productId!,
    stripe_monthly_price_id: priceId!,
    archived_price_id: archivedPriceId,
  };
}

export interface CheckoutSessionResult {
  session_id: string;
  checkout_url: string;
  /** Stripe Customer id to persist on the client, or null in demo mode. */
  customer_id: string | null;
}

/**
 * Create a Stripe Checkout session for an accepted quote.
 *
 * Line items: (1) one-time setup fee as ad-hoc `price_data` using the
 * per-client amount from the quote, and (2) the stored monthly Price from the
 * plan with `trial_period_days: 14` so the first recurring charge fires after
 * the 14-day warming window.
 *
 * In demo mode, returns a deterministic URL pointing straight to the in-app
 * welcome page (no real Stripe hop), so the full accept flow is clickable
 * without keys.
 */
export async function createCheckoutSessionForQuote({
  quote,
  client,
  plan,
  origin,
}: {
  quote: Quote;
  client: Client;
  plan: PricingPlan | null;
  origin: string;
}): Promise<CheckoutSessionResult> {
  const successUrl = `${origin}${appUrl("/billing/welcome")}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}${appUrl(`/quote/${quote.id}`)}?t=${quote.signed_url_hash}&canceled=1`;

  if (isStripeDemoMode()) {
    const sessionId = `cs_demo_${Date.now().toString(36)}`;
    const url = `${origin}${appUrl("/billing/welcome")}?session_id=${sessionId}&demo=1&quote_id=${quote.id}`;
    return {
      session_id: sessionId,
      checkout_url: url,
      customer_id: null,
    };
  }

  if (!plan?.stripe_monthly_price_id) {
    throw new Error(
      "Plan missing stripe_monthly_price_id — sync the plan to Stripe first.",
    );
  }

  const stripe = getStripe();

  let customerId = client.stripe_customer_id ?? null;
  if (!customerId) {
    const created = await stripe.customers.create(
      {
        email: quote.sent_to_email || client.contact_email || undefined,
        name: client.name,
        metadata: {
          client_id: client.id,
          organization_id: client.organization_id,
        },
      },
      { idempotencyKey: `client_customer_${client.id}` },
    );
    customerId = created.id;
  }

  type CreateParams = NonNullable<
    Parameters<typeof stripe.checkout.sessions.create>[0]
  >;
  type LineItem = NonNullable<CreateParams["line_items"]>[number];
  const lineItems: LineItem[] = [];
  if (quote.setup_fee_cents > 0) {
    lineItems.push({
      price_data: {
        currency: quote.currency,
        unit_amount: quote.setup_fee_cents,
        product_data: {
          name: `Setup fee — ${client.name}`,
          description: "One-time onboarding and inbox warming.",
        },
      },
      quantity: 1,
    });
  }
  lineItems.push({
    price: plan.stripe_monthly_price_id,
    quantity: 1,
  });

  const metadata: Record<string, string> = {
    client_id: client.id,
    plan_id: plan.id,
    quote_id: quote.id,
    organization_id: client.organization_id,
  };

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: client.id,
      line_items: lineItems,
      subscription_data: {
        trial_period_days: 14,
        metadata,
      },
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_method_types: ["card"],
      expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    },
    { idempotencyKey: `quote_accept_${quote.id}` },
  );

  return {
    session_id: session.id,
    checkout_url: session.url || "",
    customer_id: customerId,
  };
}
