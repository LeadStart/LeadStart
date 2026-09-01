import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/api-url";
import {
  buildQuoteProposalEmail,
  QUOTE_EMAIL_SUBJECT,
  QUOTE_EMAIL_FROM_FALLBACK,
} from "@/lib/email/quote-proposal";
import {
  DEFAULT_WARMING_DAYS,
  computeLaunchDate,
  nextBusinessDay,
} from "@/lib/billing/schedule";
import type { Quote, Client } from "@/types/app";

interface CreateQuoteBody {
  client_id: string;
  plan_id: string | null;
  plan_name_snapshot: string | null;
  monthly_price_cents: number;
  setup_fee_cents: number;
  contact_sourcing_cents: number;
  contacts_count: number | null;
  warming_days: number;
  /** 'derived' (from warming days) or 'fixed' (admin-pinned calendar date). */
  launch_date_mode: "derived" | "fixed";
  /** Only used when launch_date_mode === 'fixed': the pinned date (YYYY-MM-DD). */
  launch_date: string | null;
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
  const now = new Date().toISOString();
  const sendNow = body.send_now === true;

  const quoteNumber = await nextQuoteNumber(supabase, organizationId);
  const signedUrlHash = randomBytes(24).toString("hex");

  const warmingDays = body.warming_days ?? DEFAULT_WARMING_DAYS;
  const launchMode: "derived" | "fixed" =
    body.launch_date_mode === "fixed" ? "fixed" : "derived";
  // Freeze the launch (first-charge) date now so every surface reads one stable
  // value instead of recomputing from "now". 'fixed' rolls the admin's pinned
  // date to the next sending day; the default derives it from the warming
  // window off today. (No send-later flow exists yet, so "now" == send.)
  const launch =
    launchMode === "fixed" && body.launch_date
      ? nextBusinessDay(new Date(body.launch_date))
      : computeLaunchDate(new Date(), warmingDays);
  const launchIso = launch.toISOString();

  // Keep the quote's validity window safely before launch: a client accepting
  // after the frozen launch day would have no warm-up runway (and Stripe rejects
  // a trial_end in the past). Clamp an over-long expiry to the day before launch.
  let expiresAt = body.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() >= launch.getTime()) {
    expiresAt = new Date(launch.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }

  const newQuote: Quote = {
    id: randomUUID(),
    organization_id: organizationId,
    client_id: body.client_id,
    quote_number: quoteNumber,
    plan_id: null,
    plan_name_snapshot: body.plan_name_snapshot ?? null,
    monthly_price_cents: body.monthly_price_cents,
    setup_fee_cents: body.setup_fee_cents,
    contact_sourcing_cents: body.contact_sourcing_cents ?? 0,
    contacts_count: body.contacts_count ?? null,
    warming_days: warmingDays,
    launch_date: launchIso,
    launch_date_mode: launchMode,
    currency: body.currency || "usd",
    scope_of_work: body.scope_of_work || null,
    terms: body.terms || null,
    signed_url_hash: signedUrlHash,
    status: sendNow ? "sent" : "draft",
    expires_at: expiresAt,
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
        from: process.env.EMAIL_FROM || QUOTE_EMAIL_FROM_FALLBACK,
        to: body.sent_to_email,
        subject: QUOTE_EMAIL_SUBJECT,
        html: buildQuoteProposalEmail({
          contactName: client?.name || "",
          monthlyCents: quote.monthly_price_cents,
          setupCents: quote.setup_fee_cents,
          contactSourcingCents: quote.contact_sourcing_cents,
          contactsCount: quote.contacts_count,
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
