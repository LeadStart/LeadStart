import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
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

interface UpdateQuoteBody {
  client_id: string;
  monthly_price_cents: number;
  setup_fee_cents: number;
  contact_sourcing_cents: number;
  contacts_count: number | null;
  warming_days: number;
  launch_date_mode: "derived" | "fixed";
  launch_date: string | null;
  currency: string;
  scope_of_work: string | null;
  terms: string | null;
  sent_to_email: string | null;
  expires_at: string | null;
  /** When true, transition the draft to "sent" and email the proposal. */
  send_now: boolean;
}

/**
 * Edit an existing DRAFT quote. Owner/va only. Recomputes the frozen launch date
 * and clamps expiry exactly like create. Optionally sends (draft → sent + email).
 *
 * The read goes through the user client so RLS confirms the quote is in the
 * caller's org (authorization); the write uses the service-role client because
 * the quotes table is service-role-only under the hardened RLS (migration 00100).
 */
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
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: existingRow } = await supabase
    .from("quotes")
    .select()
    .eq("id", id)
    .single();
  const existing = existingRow as unknown as Quote | null;
  if (!existing) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (existing.status !== "draft") {
    return NextResponse.json(
      { error: "Only draft quotes can be edited" },
      { status: 409 },
    );
  }

  const body = (await req.json()) as UpdateQuoteBody;
  const sendNow = body.send_now === true;
  const now = new Date().toISOString();

  const warmingDays = body.warming_days ?? DEFAULT_WARMING_DAYS;
  const launchMode: "derived" | "fixed" =
    body.launch_date_mode === "fixed" ? "fixed" : "derived";
  const launch =
    launchMode === "fixed" && body.launch_date
      ? nextBusinessDay(new Date(body.launch_date))
      : computeLaunchDate(new Date(), warmingDays);

  let expiresAt = body.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() >= launch.getTime()) {
    expiresAt = new Date(launch.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }

  const updates: Record<string, unknown> = {
    client_id: body.client_id,
    monthly_price_cents: body.monthly_price_cents,
    setup_fee_cents: body.setup_fee_cents,
    contact_sourcing_cents: body.contact_sourcing_cents ?? 0,
    contacts_count: body.contacts_count ?? null,
    warming_days: warmingDays,
    launch_date: launch.toISOString(),
    launch_date_mode: launchMode,
    currency: body.currency || "usd",
    scope_of_work: body.scope_of_work || null,
    terms: body.terms || null,
    expires_at: expiresAt,
    updated_at: now,
  };
  if (sendNow) {
    updates.status = "sent";
    updates.sent_at = now;
    updates.sent_to_email = body.sent_to_email;
    updates.sent_by = session.user.id;
  }

  const admin = createAdminClient();
  const { data: updated, error: updateErr } = await admin
    .from("quotes")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (updateErr) {
    console.error("Quote update failed:", updateErr);
    return NextResponse.json(
      { error: `Could not save quote: ${updateErr.message}` },
      { status: 500 },
    );
  }
  const quote = updated as unknown as Quote;

  // Send the proposal email when transitioning to "sent".
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
      const quoteUrl = `${origin}${appUrl(`/quote/${id}`)}?t=${existing.signed_url_hash}`;

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
