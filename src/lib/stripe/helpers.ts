import "server-only";
import { appUrl } from "@/lib/api-url";
import type { Client, PricingPlan, Quote } from "@/types/app";
import { getStripe, isStripeDemoMode } from "./client";
import { computeLaunchDate } from "@/lib/billing/schedule";

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
 * subscriptions stay on their original price: Stripe default behavior,
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
        nickname: `${target.name}, monthly`,
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
  /** Embedded Checkout client secret (null in demo mode). */
  client_secret: string | null;
  /** Stripe publishable key so the client can init Stripe.js (null in demo). */
  publishable_key: string | null;
  /** Stripe Customer id to persist on the client, or null in demo mode. */
  customer_id: string | null;
  /** Demo-only: where to send the client since there's no real Checkout. */
  demo_redirect_url: string | null;
}

/**
 * Create an EMBEDDED Stripe Checkout session for an accepted quote.
 *
 * Tiers are retired, so every line is ad-hoc `price_data`: one-time contact
 * sourcing (if sold) + one-time setup fee (if any) + the recurring Lead
 * management subscription. The warm-up is a per-quote trial whose `trial_end`
 * lands on the Mon–Fri launch day, so the first monthly charge is assessed on
 * launch day.
 *
 * `ui_mode: "embedded"` returns a `client_secret` the client mounts inside our
 * own on-site modal (no redirect to Stripe). In demo mode (no key) we return a
 * `demo_redirect_url` straight to the welcome page so the flow stays clickable.
 */
export async function createCheckoutSessionForQuote({
  quote,
  client,
  origin,
}: {
  quote: Quote;
  client: Client;
  origin: string;
}): Promise<CheckoutSessionResult> {
  const returnUrl = `${origin}${appUrl("/billing/welcome")}?session_id={CHECKOUT_SESSION_ID}`;

  if (isStripeDemoMode()) {
    const sessionId = `cs_demo_${Date.now().toString(36)}`;
    return {
      session_id: sessionId,
      client_secret: null,
      publishable_key: null,
      customer_id: null,
      demo_redirect_url: `${origin}${appUrl("/billing/welcome")}?session_id=${sessionId}&demo=1&quote_id=${quote.id}`,
    };
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

  // One-time: contact sourcing (if sold).
  if (quote.contact_sourcing_cents > 0) {
    lineItems.push({
      price_data: {
        currency: quote.currency,
        unit_amount: quote.contact_sourcing_cents,
        product_data: {
          name: `Contact sourcing, ${client.name}`,
          description: quote.contacts_count
            ? `${quote.contacts_count.toLocaleString()} verified contacts (one-time).`
            : "One-time contact sourcing.",
        },
      },
      quantity: 1,
    });
  }
  // One-time: setup fee.
  if (quote.setup_fee_cents > 0) {
    lineItems.push({
      price_data: {
        currency: quote.currency,
        unit_amount: quote.setup_fee_cents,
        product_data: {
          name: `Setup fee, ${client.name}`,
          description: "One-time onboarding and inbox warming.",
        },
      },
      quantity: 1,
    });
  }
  // Recurring: Lead management (ad-hoc, no stored plan price).
  lineItems.push({
    price_data: {
      currency: quote.currency,
      unit_amount: quote.monthly_price_cents,
      recurring: { interval: "month" },
      product_data: {
        name: "Lead management",
        description: "Monthly managed cold-email service.",
      },
    },
    quantity: 1,
  });

  const metadata: Record<string, string> = {
    client_id: client.id,
    quote_id: quote.id,
    organization_id: client.organization_id,
    monthly_cents: String(quote.monthly_price_cents),
    setup_fee_cents: String(quote.setup_fee_cents),
    contact_sourcing_cents: String(quote.contact_sourcing_cents),
    contacts_count:
      quote.contacts_count != null ? String(quote.contacts_count) : "",
    warming_days: String(quote.warming_days),
    launch_date: quote.launch_date ?? "",
  };

  // Warm-up → trial that ends on the FROZEN launch day stored on the quote, so
  // the first charge lands on exactly the date the client was shown. Legacy
  // quotes with no stored date fall back to the old on-the-fly computation. If
  // the frozen day has already passed (client accepted late, e.g. an open-ended
  // quote with no expiry), skip the trial and bill now: Stripe rejects a
  // trial_end in the past.
  const launch = quote.launch_date
    ? new Date(quote.launch_date)
    : computeLaunchDate(new Date(), quote.warming_days);
  const useTrial = launch.getTime() > Date.now() + 3600 * 1000;
  const trialEndUnix = Math.floor(launch.getTime() / 1000);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      ui_mode: "embedded_page",
      customer: customerId,
      client_reference_id: client.id,
      line_items: lineItems,
      subscription_data: {
        ...(useTrial ? { trial_end: trialEndUnix } : {}),
        metadata,
      },
      metadata,
      return_url: returnUrl,
      payment_method_types: ["card"],
    },
    { idempotencyKey: `quote_accept_${quote.id}` },
  );

  return {
    session_id: session.id,
    client_secret: session.client_secret ?? null,
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
    customer_id: customerId,
    demo_redirect_url: null,
  };
}

export interface TokenPackCheckoutResult {
  /** Hosted Stripe Checkout URL to redirect the buyer to (or a demo URL). */
  url: string | null;
  demo: boolean;
}

/**
 * Create a HOSTED Stripe Checkout session for a one-time token-pack purchase
 * (the self-serve token product). Fully data-driven: the pack's price is ad-hoc
 * `price_data` from token_packs.price_usd, so defining a pack is just entering a
 * price: no pre-created Stripe products. Everything the webhook needs to credit
 * the ledger rides in `metadata` (purpose + org + tokens), and the credit is
 * idempotent per Checkout session (see the unique index in migration 00108), so
 * no idempotency key on the session itself: each purchase is its own session.
 *
 * In demo mode (no STRIPE_SECRET_KEY) returns a demo URL so the flow stays
 * clickable without keys.
 */
export async function createTokenPackCheckoutSession({
  pack,
  organizationId,
  buyerEmail,
  origin,
}: {
  pack: { id: string; name: string; tokens: number; price_usd: number };
  organizationId: string;
  buyerEmail: string | null;
  origin: string;
}): Promise<TokenPackCheckoutResult> {
  const successUrl = `${origin}${appUrl("/buyer")}?purchase=success`;
  const cancelUrl = `${origin}${appUrl("/buyer")}?purchase=cancelled`;

  if (isStripeDemoMode()) {
    return { url: `${origin}${appUrl("/buyer")}?purchase=demo`, demo: true };
  }

  const stripe = getStripe();
  const tokenMeta = {
    purpose: "token_topup",
    organization_id: organizationId,
    pack_id: pack.id,
    tokens: String(pack.tokens),
  };

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(pack.price_usd * 100),
          product_data: {
            name: `${pack.name} · ${pack.tokens.toLocaleString()} tokens`,
            description: "LeadStart contact-sourcing tokens (one-time).",
          },
        },
        quantity: 1,
      },
    ],
    customer_email: buyerEmail ?? undefined,
    client_reference_id: organizationId,
    metadata: tokenMeta,
    // Mirror onto the PaymentIntent so a payment_intent.* consumer sees it too.
    payment_intent_data: { metadata: tokenMeta },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return { url: session.url, demo: false };
}
