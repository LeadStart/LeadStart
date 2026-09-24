import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_WARMING_DAYS,
  DEFAULT_QUOTE_EXPIRY_DAYS,
  resolveQuoteSchedule,
} from "./schedule";
import type { Quote } from "@/types/app";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the fresh DRAFT that a reissue produces from a source quote. Pure and
 * deterministic given `now` (aside from the random id + signed hash), so it can
 * be unit-tested without a DB. The caller supplies the pre-allocated
 * quote_number (that needs a DB scan) and persists the result.
 *
 * Priced line items + scope/terms are cloned verbatim; every lifecycle field is
 * reset to a clean draft; the schedule is reset to 'derived' off `now` with a
 * fresh default expiry (the source's frozen launch/expiry are relative to its
 * original send and would be stale, usually already in the past). sent_to_email
 * is carried so the edit dialog can pre-fill the recipient, but the quote is not
 * "sent" until the admin sends it.
 */
export function buildReissuedDraft(
  source: Quote,
  quoteNumber: string,
  now: Date,
): Quote {
  const nowIso = now.toISOString();
  const freshExpiry = new Date(
    now.getTime() + DEFAULT_QUOTE_EXPIRY_DAYS * DAY_MS,
  ).toISOString();

  const { launch, warmingDays, expiresAt } = resolveQuoteSchedule({
    from: now,
    warmingDays: source.warming_days ?? DEFAULT_WARMING_DAYS,
    launchMode: "derived",
    fixedLaunchDate: null,
    expiresAt: freshExpiry,
  });

  return {
    id: randomUUID(),
    organization_id: source.organization_id,
    client_id: source.client_id,
    quote_number: quoteNumber,
    plan_id: source.plan_id,
    plan_name_snapshot: source.plan_name_snapshot,
    monthly_price_cents: source.monthly_price_cents,
    setup_fee_cents: source.setup_fee_cents,
    contact_sourcing_cents: source.contact_sourcing_cents ?? 0,
    contacts_count: source.contacts_count ?? null,
    warming_days: warmingDays,
    launch_date: launch.toISOString(),
    launch_date_mode: "derived",
    currency: source.currency || "usd",
    scope_of_work: source.scope_of_work || null,
    terms: source.terms || null,
    signed_url_hash: randomBytes(24).toString("hex"),
    status: "draft",
    expires_at: expiresAt,
    sent_at: null,
    viewed_at: null,
    accepted_at: null,
    declined_at: null,
    sent_to_email: source.sent_to_email ?? null,
    sent_by: null,
    accepted_by_email: null,
    accepted_ip: null,
    accepted_user_agent: null,
    stripe_checkout_session_id: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
