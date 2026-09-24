import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { nextQuoteNumber } from "@/lib/billing/quote-number";
import { buildReissuedDraft } from "@/lib/billing/reissue";
import type { Quote } from "@/types/app";

/**
 * Reissue a quote. Owner/va only. Clones a non-draft quote (typically an
 * expired or already-sent one) into a FRESH DRAFT (new quote number, new
 * signed URL, fresh default expiry) and negates the source by canceling it,
 * so the previous proposal can no longer be viewed-as-live or accepted and the
 * new draft is the only active version. The draft is then editable + sendable
 * through the normal edit → send path. The clone/reset logic lives in
 * `buildReissuedDraft` (unit-tested in scripts/test-reissue.ts).
 *
 * The read goes through the user client so RLS confirms the quote is in the
 * caller's org (authorization); both writes use the service-role client because
 * the quotes table is service-role-only under the hardened RLS (migration 00100).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = (user as { app_metadata?: { role?: string } })
    .app_metadata?.role;
  if (role !== "owner" && role !== "va") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: sourceRow } = await supabase
    .from("quotes")
    .select()
    .eq("id", id)
    .single();
  const source = sourceRow as unknown as Quote | null;
  if (!source) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (source.status === "draft") {
    return NextResponse.json(
      { error: "Draft quotes are edited directly; nothing to reissue." },
      { status: 409 },
    );
  }
  if (source.status === "accepted") {
    return NextResponse.json(
      { error: "An accepted quote can't be reissued." },
      { status: 409 },
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const quoteNumber = await nextQuoteNumber(supabase, source.organization_id);
  const newQuote = buildReissuedDraft(source, quoteNumber, now);

  const admin = createAdminClient();
  const { data: inserted, error: insertErr } = await admin
    .from("quotes")
    .insert(newQuote as unknown as Record<string, unknown>)
    .select()
    .single();
  if (insertErr) {
    console.error("Quote reissue insert failed:", insertErr);
    return NextResponse.json(
      { error: `Could not reissue quote: ${insertErr.message}` },
      { status: 500 },
    );
  }
  const quote = (inserted as unknown as Quote) ?? newQuote;

  // Negate the source: cancel it so the old link can't be accepted and it no
  // longer counts as a live/pending proposal. Done only after the new draft is
  // safely persisted. A failure here leaves the reissue in place but the old
  // quote un-canceled, so we surface a flag instead of silently succeeding.
  let sourceCancelFailed = false;
  const { error: cancelErr } = await admin
    .from("quotes")
    .update({ status: "canceled", updated_at: nowIso } as Record<
      string,
      unknown
    >)
    .eq("id", id);
  if (cancelErr) {
    console.error("Quote reissue: source cancel failed:", cancelErr);
    sourceCancelFailed = true;
  }

  return NextResponse.json({ quote, source_cancel_failed: sourceCancelFailed });
}
