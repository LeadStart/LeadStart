/**
 * Backfill existing Stripe customers/subscriptions/invoices into Supabase.
 *
 * Use this for subs that pre-date the webhook endpoint — Stripe only delivers
 * events created after the endpoint exists, so historical state needs a pull.
 *
 *   node scripts/backfill-stripe.mjs              # dry-run: list what would change
 *   node scripts/backfill-stripe.mjs --apply      # write the changes
 *
 * Matches Stripe customers to `clients` rows by:
 *   1. clients.stripe_customer_id (if already set)
 *   2. clients.contact_email (case-insensitive)
 * Unmatched customers are reported so you can add them manually before re-running.
 *
 * Also writes the organization_id / client_id / plan_id metadata back onto the
 * Stripe subscription so future webhook events route correctly.
 */
import { readFileSync } from "node:fs";
import Stripe from "stripe";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_KEY = env.STRIPE_SECRET_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
if (!STRIPE_KEY) {
  console.error("Missing STRIPE_SECRET_KEY in .env.local");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2026-03-25.dahlia" });

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: init.method === "POST" ? "return=representation,resolution=merge-duplicates" : "return=representation",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

console.log(`Mode: ${APPLY ? "APPLY (writes will happen)" : "DRY-RUN (no writes)"}`);
console.log(`Stripe: ${STRIPE_KEY.startsWith("sk_live_") ? "LIVE" : "TEST"}\n`);

// 1. Load all clients + plans from Supabase
const clients = await rest("clients?select=id,name,organization_id,contact_email,stripe_customer_id");
const plans = await rest("pricing_plans?select=id,name,stripe_product_id,stripe_monthly_price_id,monthly_price_cents,organization_id");
console.log(`Loaded ${clients.length} clients and ${plans.length} pricing plans from Supabase.\n`);

// 2. Pull all Stripe customers + subscriptions + invoices
const customers = [];
for await (const c of stripe.customers.list({ limit: 100 })) customers.push(c);

const subscriptions = [];
for await (const s of stripe.subscriptions.list({ limit: 100, status: "all" })) subscriptions.push(s);

const invoices = [];
for await (const inv of stripe.invoices.list({ limit: 100 })) invoices.push(inv);

console.log(`Stripe has: ${customers.length} customers, ${subscriptions.length} subscriptions, ${invoices.length} invoices.\n`);

// Manual mapping for Stripe customers whose name/email doesn't match a client row.
// Fill this in after the first dry-run for any "unmatched" customers you want to backfill.
// Key = Stripe customer id, Value = Supabase client id.
const MANUAL_MAPPING = {
  // "cus_Ty6xtsgqpCeKkB": "<client-uuid>",
};

// 3. Match each Stripe customer to a Supabase client
function matchCustomer(stripeCustomer) {
  if (MANUAL_MAPPING[stripeCustomer.id]) {
    return clients.find((c) => c.id === MANUAL_MAPPING[stripeCustomer.id]) || null;
  }
  const byId = clients.find((c) => c.stripe_customer_id === stripeCustomer.id);
  if (byId) return byId;
  const email = (stripeCustomer.email || "").toLowerCase();
  if (email) {
    const byEmail = clients.find(
      (c) => (c.contact_email || "").toLowerCase() === email,
    );
    if (byEmail) return byEmail;
  }
  // Match by exact (case-insensitive) customer name ↔ client name.
  const name = (stripeCustomer.name || "").trim().toLowerCase();
  if (name) {
    const byName = clients.find(
      (c) => c.name.trim().toLowerCase() === name,
    );
    if (byName) return byName;
  }
  return null;
}

function matchPlan(stripeSub) {
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  return plans.find((p) => p.stripe_monthly_price_id === priceId) || null;
}

// For subs whose Stripe price doesn't match an existing pricing_plan row,
// we fetch the Stripe Product + Price and auto-create a plan from that data
// (keyed by stripe_monthly_price_id so we only create one per unique price).
const planCreations = new Map(); // priceId -> { action, pendingId }
async function planToCreateFor(stripeSub, organizationId) {
  const priceId = stripeSub.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  const existing = plans.find((p) => p.stripe_monthly_price_id === priceId);
  if (existing) return existing;
  if (planCreations.has(priceId)) return planCreations.get(priceId).row;

  const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
  const product = price.product;
  const productName =
    (typeof product === "object" && product && "name" in product
      ? product.name
      : null) || "Imported plan";
  const productDesc =
    (typeof product === "object" && product && "description" in product
      ? product.description
      : null) || null;
  const productId =
    typeof product === "string"
      ? product
      : product && "id" in product
        ? product.id
        : null;

  const baseSlug = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const slug = baseSlug || "imported-plan";

  const row = {
    organization_id: organizationId,
    slug,
    name: productName,
    description: productDesc,
    features: [],
    monthly_price_cents: price.unit_amount || 0,
    currency: price.currency || "usd",
    stripe_product_id: productId,
    stripe_monthly_price_id: priceId,
    scope_template: null,
    active: true,
    sort_order: 0,
  };
  planCreations.set(priceId, { row });
  return row;
}

const actions = [];
const unmatched = [];

for (const cust of customers) {
  const client = matchCustomer(cust);
  if (!client) {
    unmatched.push(cust);
    continue;
  }

  const custSubs = subscriptions.filter(
    (s) => (typeof s.customer === "string" ? s.customer : s.customer?.id) === cust.id,
  );
  const custInvoices = invoices.filter(
    (i) => (typeof i.customer === "string" ? i.customer : i.customer?.id) === cust.id,
  );

  // Always set stripe_customer_id on client if missing.
  if (!client.stripe_customer_id) {
    actions.push({
      kind: "update_client_customer_id",
      client_id: client.id,
      client_name: client.name,
      stripe_customer_id: cust.id,
    });
  }

  for (const sub of custSubs) {
    const existingPlan = matchPlan(sub);
    let planId = existingPlan?.id || null;
    let planName = existingPlan?.name || null;
    let pendingPriceId = null;
    if (!existingPlan) {
      const toCreate = await planToCreateFor(sub, client.organization_id);
      if (toCreate) {
        planName = toCreate.name;
        pendingPriceId = toCreate.stripe_monthly_price_id;
      }
    }
    const firstItem = sub.items?.data?.[0];
    const row = {
      organization_id: client.organization_id,
      client_id: client.id,
      plan_id: planId,
      stripe_customer_id: cust.id,
      stripe_subscription_id: sub.id,
      status: sub.status,
      trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
      current_period_start: firstItem?.current_period_start
        ? new Date(firstItem.current_period_start * 1000).toISOString()
        : null,
      current_period_end: firstItem?.current_period_end
        ? new Date(firstItem.current_period_end * 1000).toISOString()
        : null,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      canceled_at: sub.canceled_at
        ? new Date(sub.canceled_at * 1000).toISOString()
        : null,
    };
    actions.push({
      kind: "upsert_subscription",
      client_name: client.name,
      stripe_subscription_id: sub.id,
      plan_name: planName || "(no price on subscription)",
      pending_price_id: pendingPriceId, // resolved to plan_id in apply phase
      status: sub.status,
      row,
      existing_metadata: sub.metadata || {},
    });
  }

  for (const inv of custInvoices) {
    if (!inv.id) continue;
    const parentSub = inv.parent?.subscription_details?.subscription;
    const subscriptionId =
      typeof parentSub === "string" ? parentSub : parentSub?.id;
    const row = {
      id: inv.id,
      organization_id: client.organization_id,
      client_id: client.id,
      stripe_customer_id: cust.id,
      stripe_subscription_id: subscriptionId,
      stripe_invoice_number: inv.number,
      amount_cents: inv.total,
      amount_paid_cents: inv.amount_paid,
      amount_due_cents: inv.amount_due,
      currency: inv.currency,
      status: inv.status || "open",
      period_start: inv.period_start
        ? new Date(inv.period_start * 1000).toISOString()
        : null,
      period_end: inv.period_end
        ? new Date(inv.period_end * 1000).toISOString()
        : null,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf_url: inv.invoice_pdf,
      issued_at: inv.status_transitions?.finalized_at
        ? new Date(inv.status_transitions.finalized_at * 1000).toISOString()
        : null,
      paid_at: inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
        : null,
    };
    actions.push({
      kind: "upsert_invoice",
      client_name: client.name,
      invoice_id: inv.id,
      status: inv.status,
      amount_cents: inv.total,
      row,
    });
  }
}

// 4. Print plan
console.log("=== Planned actions ===");
if (planCreations.size > 0) {
  for (const [priceId, { row }] of planCreations) {
    console.log(
      `  [plan   ] create "${row.name}" @ $${(row.monthly_price_cents / 100).toFixed(2)}/mo (price=${priceId})`,
    );
  }
}
for (const a of actions) {
  if (a.kind === "update_client_customer_id") {
    console.log(
      `  [client ] ${a.client_name}: set stripe_customer_id=${a.stripe_customer_id}`,
    );
  } else if (a.kind === "upsert_subscription") {
    console.log(
      `  [sub    ] ${a.client_name}: ${a.stripe_subscription_id} (${a.status}) plan=${a.plan_name}`,
    );
  } else if (a.kind === "upsert_invoice") {
    console.log(
      `  [invoice] ${a.client_name}: ${a.invoice_id} (${a.status}) $${(a.amount_cents / 100).toFixed(2)}`,
    );
  }
}
if (actions.length === 0 && planCreations.size === 0) {
  console.log("  (nothing to do)");
}

if (unmatched.length > 0) {
  console.log(`\n=== Unmatched Stripe customers (add to clients or set stripe_customer_id manually) ===`);
  for (const c of unmatched) {
    console.log(`  ${c.id}  name=${c.name || "(no name)"}  email=${c.email || "(no email)"}`);
  }
}

if (!APPLY) {
  console.log("\nDry-run complete. Re-run with --apply to write.");
  process.exit(0);
}

// 5. Apply
console.log("\n=== Applying ===");

// Create any needed pricing_plans first, capture their ids so subsequent
// subscription upserts can reference them via `pending_price_id`.
const priceIdToPlanId = new Map();
for (const [priceId, { row }] of planCreations) {
  // Ensure slug is unique per-org by appending a short hash if needed.
  const existingSlugs = plans
    .filter((p) => p.organization_id === row.organization_id)
    .map((p) => p.slug);
  let slug = row.slug;
  let attempt = 1;
  while (existingSlugs.includes(slug)) {
    slug = `${row.slug}-${attempt++}`;
  }
  const rowWithSlug = { ...row, slug };
  const created = await rest(`pricing_plans`, {
    method: "POST",
    body: JSON.stringify(rowWithSlug),
  });
  const createdId = Array.isArray(created) ? created[0]?.id : created?.id;
  if (!createdId) {
    console.log(`  ! failed to create plan for ${priceId}`);
    continue;
  }
  priceIdToPlanId.set(priceId, createdId);
  plans.push({ ...rowWithSlug, id: createdId });
  console.log(`  ✓ plan "${row.name}" → ${createdId}`);
}

for (const a of actions) {
  if (a.kind === "update_client_customer_id") {
    await rest(`clients?id=eq.${a.client_id}`, {
      method: "PATCH",
      body: JSON.stringify({ stripe_customer_id: a.stripe_customer_id }),
    });
    console.log(`  ✓ client ${a.client_name}`);
  } else if (a.kind === "upsert_subscription") {
    // Late-bind plan_id from the plans we just created.
    if (!a.row.plan_id && a.pending_price_id) {
      const resolved = priceIdToPlanId.get(a.pending_price_id);
      if (resolved) a.row.plan_id = resolved;
    }
    await rest(`client_subscriptions?on_conflict=stripe_subscription_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(a.row),
    });
    console.log(`  ✓ sub ${a.stripe_subscription_id}`);

    // Also push metadata onto Stripe so future webhooks route correctly.
    const needsMetadata =
      a.existing_metadata.client_id !== a.row.client_id ||
      a.existing_metadata.organization_id !== a.row.organization_id ||
      (a.row.plan_id && a.existing_metadata.plan_id !== a.row.plan_id);
    if (needsMetadata) {
      await stripe.subscriptions.update(a.stripe_subscription_id, {
        metadata: {
          ...a.existing_metadata,
          client_id: a.row.client_id,
          organization_id: a.row.organization_id,
          ...(a.row.plan_id ? { plan_id: a.row.plan_id } : {}),
        },
      });
      console.log(`    └─ pushed metadata to Stripe`);
    }
  } else if (a.kind === "upsert_invoice") {
    await rest(`billing_invoices?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(a.row),
    });
    console.log(`  ✓ invoice ${a.invoice_id}`);
  }
}
console.log("\nDone. Refresh the admin billing page to see the results.");
