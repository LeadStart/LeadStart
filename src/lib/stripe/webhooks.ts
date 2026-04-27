import "server-only";
import type Stripe from "stripe";
import type { createClient } from "@/lib/supabase/server";
import { buildSubscriptionStartedEmail } from "@/lib/email/subscription-started";
import { buildPaymentFailedEmail } from "@/lib/email/payment-failed";
import { buildInvoiceEmail } from "@/lib/email/invoice";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

function canSendEmail(): boolean {
  return (
    !!process.env.RESEND_API_KEY &&
    process.env.RESEND_API_KEY.startsWith("re_")
  );
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!canSendEmail()) return;
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from:
        process.env.EMAIL_FROM ||
        "LeadStart <info@no-reply.leadstart.io>",
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error("Webhook email send failed:", err);
  }
}

/**
 * Route a Stripe event to the right handler. Caller is responsible for
 * signature verification, idempotency dedupe, and persisting the event row
 * — this function only mutates business state.
 *
 * Unknown event types are silently ignored (Stripe sends many we don't care
 * about; rejecting them would cause retry loops).
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  supabase: SupabaseClient,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session,
        supabase,
      );
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionUpdated(
        event.data.object as Stripe.Subscription,
        supabase,
      );
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        supabase,
      );
    case "invoice.finalized":
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided":
    case "invoice.marked_uncollectible":
      return handleInvoiceEvent(
        event.type,
        event.data.object as Stripe.Invoice,
        supabase,
      );
    default:
      return;
  }
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  supabase: SupabaseClient,
) {
  const md = session.metadata ?? {};
  const organizationId = md.organization_id;
  const clientId = md.client_id;
  const planId = md.plan_id || null;
  const quoteId = md.quote_id || null;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;

  if (!organizationId || !clientId || !customerId) {
    return;
  }

  // Upsert subscription — field set intentionally minimal; the
  // customer.subscription.updated event fires right after and fills in
  // period bounds, trial_end, etc.
  if (subscriptionId) {
    await supabase.from("client_subscriptions").upsert(
      {
        organization_id: organizationId,
        client_id: clientId,
        plan_id: planId,
        quote_id: quoteId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: "trialing",
        setup_fee_paid_at: new Date().toISOString(),
      } as Record<string, unknown>,
      { onConflict: "stripe_subscription_id" },
    );
  }

  // Mark the Checkout session row complete.
  await supabase
    .from("payment_links")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    } as Record<string, unknown>)
    .eq("stripe_checkout_session_id", session.id);

  // Persist the Stripe Customer on the client for portal + upsells.
  await supabase
    .from("clients")
    .update({ stripe_customer_id: customerId } as Record<string, unknown>)
    .eq("id", clientId);

  // Quote status should already be 'accepted' from /accept endpoint; this
  // is a safety net in case the recipient went through a different entry.
  if (quoteId) {
    await supabase
      .from("quotes")
      .update({
        stripe_checkout_session_id: session.id,
      } as Record<string, unknown>)
      .eq("id", quoteId);
  }

  // "You're in — first charge on {date}" email via Resend.
  const toEmail = session.customer_email || session.customer_details?.email;
  if (toEmail) {
    const { data: clientRow } = await supabase
      .from("clients")
      .select()
      .eq("id", clientId)
      .single();
    const client = clientRow as unknown as { name: string } | null;
    let planName = "Custom";
    let monthlyCents = 0;
    if (planId) {
      const { data: planRow } = await supabase
        .from("pricing_plans")
        .select()
        .eq("id", planId)
        .single();
      const plan = planRow as unknown as {
        name: string;
        monthly_price_cents: number;
      } | null;
      if (plan) {
        planName = plan.name;
        monthlyCents = plan.monthly_price_cents;
      }
    }
    const firstCharge = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await sendEmail(
      toEmail,
      "You're in — campaigns launching soon",
      buildSubscriptionStartedEmail({
        clientName: client?.name || "",
        planName,
        firstChargeDate: firstCharge,
        monthlyCents,
      }),
    );
  }
}

async function handleSubscriptionUpdated(
  sub: Stripe.Subscription,
  supabase: SupabaseClient,
) {
  // API version 2026-03-25: current_period_* moved from the Subscription root
  // to its SubscriptionItems. All items on a single subscription share the
  // same period, so reading the first is sufficient.
  const firstItem = sub.items?.data?.[0];
  const periodStart = firstItem?.current_period_start
    ? new Date(firstItem.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000).toISOString()
    : null;
  const trialEnd = sub.trial_end
    ? new Date(sub.trial_end * 1000).toISOString()
    : null;

  // Stripe keeps sub.status = "active" while pause_collection is set, so
  // reflect the pause explicitly on our mirror.
  const mirroredStatus = sub.pause_collection ? "paused" : sub.status;

  await supabase
    .from("client_subscriptions")
    .update({
      status: mirroredStatus,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      trial_end: trialEnd,
      cancel_at_period_end: sub.cancel_at_period_end,
    } as Record<string, unknown>)
    .eq("stripe_subscription_id", sub.id);
}

async function handleSubscriptionDeleted(
  sub: Stripe.Subscription,
  supabase: SupabaseClient,
) {
  const canceledAt = sub.canceled_at
    ? new Date(sub.canceled_at * 1000).toISOString()
    : new Date().toISOString();
  await supabase
    .from("client_subscriptions")
    .update({
      status: "canceled",
      canceled_at: canceledAt,
    } as Record<string, unknown>)
    .eq("stripe_subscription_id", sub.id);
}

async function handleInvoiceEvent(
  eventType: string,
  invoice: Stripe.Invoice,
  supabase: SupabaseClient,
) {
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  // API version 2026-03-25: invoice.subscription moved to parent.subscription_details.
  const parentSub = invoice.parent?.subscription_details?.subscription;
  const subscriptionId =
    typeof parentSub === "string" ? parentSub : parentSub?.id;

  // Find the client by Stripe customer id so we can scope the invoice.
  const { data: clientRows } = await supabase
    .from("clients")
    .select()
    .eq("stripe_customer_id", customerId || "")
    .limit(1);
  const client =
    ((clientRows as unknown as Array<{ id: string; organization_id: string }>) ||
      [])[0] ?? null;

  if (!invoice.id || !client) {
    return;
  }

  const paidAt =
    invoice.status_transitions?.paid_at != null
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      : null;

  await supabase.from("billing_invoices").upsert(
    {
      id: invoice.id,
      organization_id: client.organization_id,
      client_id: client.id,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      stripe_invoice_number: invoice.number,
      amount_cents: invoice.total,
      amount_paid_cents: invoice.amount_paid,
      amount_due_cents: invoice.amount_due,
      currency: invoice.currency,
      status: invoice.status || "open",
      period_start: invoice.period_start
        ? new Date(invoice.period_start * 1000).toISOString()
        : null,
      period_end: invoice.period_end
        ? new Date(invoice.period_end * 1000).toISOString()
        : null,
      hosted_invoice_url: invoice.hosted_invoice_url,
      invoice_pdf_url: invoice.invoice_pdf,
      issued_at:
        invoice.status_transitions?.finalized_at != null
          ? new Date(
              invoice.status_transitions.finalized_at * 1000,
            ).toISOString()
          : null,
      paid_at: paidAt,
    } as Record<string, unknown>,
    { onConflict: "id" },
  );

  // Newly finalized open invoice → send branded LeadStart invoice email.
  // Stripe still sends its own; ours is the on-brand cover. We skip if the
  // hosted URL isn't set yet (the Pay button needs it) or if status flipped
  // straight to paid (covered by the receipt flow, not an "amount due" mail).
  if (
    eventType === "invoice.finalized" &&
    invoice.status === "open" &&
    invoice.hosted_invoice_url
  ) {
    const toEmail =
      invoice.customer_email ||
      (typeof invoice.customer === "object" && invoice.customer
        ? (invoice.customer as { email?: string }).email
        : null);
    if (toEmail) {
      const lineItems = (invoice.lines?.data ?? []).map((line) => {
        const start = line.period?.start
          ? new Date(line.period.start * 1000).toISOString()
          : null;
        const end = line.period?.end
          ? new Date(line.period.end * 1000).toISOString()
          : null;
        const periodLabel =
          start && end
            ? `${new Date(start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
            : null;
        return {
          description: line.description ?? "Subscription",
          periodLabel,
          amountCents: line.amount,
        };
      });
      await sendEmail(
        toEmail,
        `Invoice ${invoice.number ?? invoice.id} — $${(invoice.amount_due / 100).toFixed(2)} due`,
        buildInvoiceEmail({
          clientName:
            (client as unknown as { name?: string }).name || "",
          invoiceNumber: invoice.number ?? invoice.id,
          amountDueCents: invoice.amount_due,
          currency: invoice.currency,
          issuedAt:
            invoice.status_transitions?.finalized_at != null
              ? new Date(
                  invoice.status_transitions.finalized_at * 1000,
                ).toISOString()
              : new Date().toISOString(),
          dueAt: invoice.due_date
            ? new Date(invoice.due_date * 1000).toISOString()
            : null,
          periodStart: invoice.period_start
            ? new Date(invoice.period_start * 1000).toISOString()
            : null,
          periodEnd: invoice.period_end
            ? new Date(invoice.period_end * 1000).toISOString()
            : null,
          lineItems,
          subtotalCents: invoice.subtotal,
          taxCents: (invoice.total_taxes ?? []).reduce(
            (sum, t) => sum + (t.amount ?? 0),
            0,
          ),
          totalCents: invoice.total,
          hostedInvoiceUrl: invoice.hosted_invoice_url,
          invoicePdfUrl: invoice.invoice_pdf ?? null,
        }),
      );
    }
  }

  // Failed payment → mark the subscription past_due + send nudge.
  if (eventType === "invoice.payment_failed" && subscriptionId) {
    await supabase
      .from("client_subscriptions")
      .update({ status: "past_due" } as Record<string, unknown>)
      .eq("stripe_subscription_id", subscriptionId);

    const toEmail =
      invoice.customer_email ||
      (typeof invoice.customer === "object" && invoice.customer
        ? (invoice.customer as { email?: string }).email
        : null);
    if (toEmail) {
      await sendEmail(
        toEmail,
        "We couldn't process your payment",
        buildPaymentFailedEmail({
          clientName: client
            ? (client as unknown as { name?: string }).name || ""
            : "",
          amountCents: invoice.amount_due || invoice.total || 0,
          hostedInvoiceUrl: invoice.hosted_invoice_url || null,
        }),
      );
    }
  }
}
