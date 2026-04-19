import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/api-url";
import { buildQuoteProposalEmail } from "@/lib/email/quote-proposal";
import type { Quote, Client } from "@/types/app";

interface CreateQuoteBody {
  client_id: string;
  plan_id: string | null;
  plan_name_snapshot: string;
  monthly_price_cents: number;
  setup_fee_cents: number;
  currency: string;
  scope_of_work: string | null;
  terms: string | null;
  sent_to_email: string | null;
  expires_at: string | null;
  send_now: boolean;
}

/**
 * Allocate the next quote number for an organization (Q-YYYY-NNNN).
 * In real Supabase this should use `quote_number_counters` via an RPC for
 * atomicity under concurrency; for now we scan existing rows, which is
 * fine for the demo and single-threaded test-mode flows.
 */
async function nextQuoteNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `Q-${year}-`;
  const { data } = await supabase
    .from("quotes")
    .select("quote_number")
    .eq("organization_id", organizationId);
  const rows = (data as Array<{ quote_number: string }> | null) ?? [];
  const nums = rows
    .map((r) => r.quote_number)
    .filter((n) => n && n.startsWith(prefix))
    .map((n) => parseInt(n.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

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

  const body = (await req.json()) as CreateQuoteBody;
  if (!body.client_id) {
    return NextResponse.json(
      { error: "client_id required" },
      { status: 400 },
    );
  }
  if (!body.plan_name_snapshot?.trim()) {
    return NextResponse.json(
      { error: "plan_name_snapshot required" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const sendNow = body.send_now === true;

  const quoteNumber = await nextQuoteNumber(supabase, organizationId);
  const signedUrlHash = randomBytes(24).toString("hex");

  const newQuote: Quote = {
    id: `quote-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    organization_id: organizationId,
    client_id: body.client_id,
    quote_number: quoteNumber,
    plan_id: body.plan_id,
    plan_name_snapshot: body.plan_name_snapshot,
    monthly_price_cents: body.monthly_price_cents,
    setup_fee_cents: body.setup_fee_cents,
    currency: body.currency || "usd",
    scope_of_work: body.scope_of_work || null,
    terms: body.terms || null,
    signed_url_hash: signedUrlHash,
    status: sendNow ? "sent" : "draft",
    expires_at: body.expires_at,
    sent_at: sendNow ? now : null,
    viewed_at: null,
    accepted_at: null,
    declined_at: null,
    sent_to_email: sendNow ? body.sent_to_email : null,
    sent_by: sendNow ? session.user.id : null,
    accepted_by_email: null,
    accepted_ip: null,
    accepted_user_agent: null,
    stripe_checkout_session_id: null,
    created_at: now,
    updated_at: now,
  };

  const { data: inserted } = await supabase
    .from("quotes")
    .insert(newQuote as unknown as Record<string, unknown>);
  const quote =
    (inserted as unknown as Quote[] | null)?.[0] ?? newQuote;

  // Send proposal email when status is "sent".
  const canSendEmail =
    process.env.DEMO_MODE !== "true" &&
    !!process.env.RESEND_API_KEY &&
    process.env.RESEND_API_KEY.startsWith("re_");
  if (sendNow && body.sent_to_email && canSendEmail) {
    try {
      const { data: clientRow } = await supabase
        .from("clients")
        .select()
        .eq("id", body.client_id)
        .single();
      const client = clientRow as unknown as Client | null;

      const origin = req.nextUrl.origin;
      const quoteUrl = `${origin}${appUrl(`/quote/${newQuote.id}`)}?t=${signedUrlHash}`;

      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:
          process.env.EMAIL_FROM ||
          "LeadStart <info@no-reply.leadstart.io>",
        to: body.sent_to_email,
        subject: `Your LeadStart proposal — ${quote.quote_number}`,
        html: buildQuoteProposalEmail({
          contactName: client?.name || "",
          quoteNumber: quote.quote_number,
          planName: quote.plan_name_snapshot || "Custom",
          monthlyCents: quote.monthly_price_cents,
          setupCents: quote.setup_fee_cents,
          quoteUrl,
          expiresAt: quote.expires_at,
        }),
      });
    } catch (emailErr) {
      console.error("Failed to send quote email:", emailErr);
    }
  }

  return NextResponse.json({ quote });
}
