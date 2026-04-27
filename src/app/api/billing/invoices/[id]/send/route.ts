import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeDemoMode } from "@/lib/stripe/client";
import { buildInvoiceEmail } from "@/lib/email/invoice";
import type { BillingInvoice, Client } from "@/types/app";

interface Body {
  to_email?: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: invoiceId } = await params;

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

  const body = (await req.json().catch(() => ({}))) as Body;

  const { data: invoiceRow } = await supabase
    .from("billing_invoices")
    .select()
    .eq("id", invoiceId)
    .single();
  const invoice = invoiceRow as unknown as BillingInvoice | null;
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (!invoice.hosted_invoice_url) {
    return NextResponse.json(
      { error: "Invoice has no hosted URL yet — try again once Stripe finalizes it." },
      { status: 409 },
    );
  }

  const { data: clientRow } = await supabase
    .from("clients")
    .select()
    .eq("id", invoice.client_id)
    .single();
  const client = clientRow as unknown as Client | null;
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const toEmail =
    body.to_email?.trim() ||
    client.contact_email ||
    null;
  if (!toEmail) {
    return NextResponse.json(
      { error: "No destination email — set the client's contact email or pass to_email." },
      { status: 400 },
    );
  }

  const canSendEmail =
    !!process.env.RESEND_API_KEY &&
    process.env.RESEND_API_KEY.startsWith("re_");
  if (!canSendEmail) {
    return NextResponse.json(
      { error: "Resend is not configured (RESEND_API_KEY missing)." },
      { status: 503 },
    );
  }

  // Pull line items + tax/subtotal directly from Stripe so the email matches
  // what the customer sees on the hosted invoice page. Falls back to mirror
  // values when Stripe is in demo mode.
  let lineItems: Array<{
    description: string;
    periodLabel: string | null;
    amountCents: number;
  }> = [];
  let subtotalCents = invoice.amount_cents;
  let taxCents = 0;
  let dueAt: string | null = null;

  if (!isStripeDemoMode()) {
    try {
      const stripeInvoice = await getStripe().invoices.retrieve(invoiceId, {
        expand: ["lines"],
      });
      lineItems = (stripeInvoice.lines?.data ?? []).map((line) => {
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
      subtotalCents = stripeInvoice.subtotal ?? invoice.amount_cents;
      taxCents = (stripeInvoice.total_taxes ?? []).reduce(
        (sum, t) => sum + (t.amount ?? 0),
        0,
      );
      dueAt = stripeInvoice.due_date
        ? new Date(stripeInvoice.due_date * 1000).toISOString()
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stripe retrieve failed";
      return NextResponse.json(
        { error: `Could not load invoice from Stripe: ${msg}` },
        { status: 502 },
      );
    }
  }

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from:
        process.env.EMAIL_FROM ||
        "LeadStart <info@no-reply.leadstart.io>",
      to: toEmail,
      subject: `Invoice ${invoice.stripe_invoice_number ?? invoice.id} — $${(invoice.amount_due_cents / 100).toFixed(2)} due`,
      html: buildInvoiceEmail({
        clientName: client.name,
        invoiceNumber: invoice.stripe_invoice_number ?? invoice.id,
        amountDueCents: invoice.amount_due_cents,
        currency: invoice.currency,
        issuedAt: invoice.issued_at ?? invoice.created_at,
        dueAt,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
        lineItems,
        subtotalCents,
        taxCents,
        totalCents: invoice.amount_cents,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdfUrl: invoice.invoice_pdf_url,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Email send failed";
    return NextResponse.json(
      { error: `Email send failed: ${msg}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, sent_to: toEmail });
}
