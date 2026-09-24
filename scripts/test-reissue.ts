// Unit test for buildReissuedDraft (src/lib/billing/reissue.ts).
//
// The reissue action clones a sent/expired quote into a fresh DRAFT and (in the
// route) cancels the source. This test guards the clone/reset logic: the draft
// must carry the priced line items + scope/terms, mint a NEW link, reset the
// acceptance window to a fresh default, wipe every lifecycle field, and never
// carry the source's stale (often past) frozen launch forward.
//
// Run:  npx tsx scripts/test-reissue.ts

import { buildReissuedDraft } from "../src/lib/billing/reissue";
import { DEFAULT_QUOTE_EXPIRY_DAYS } from "../src/lib/billing/schedule";
import type { Quote } from "../src/types/app";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
// Deterministic reference "now" (a Monday), matching test-quote-schedule.ts.
const NOW = new Date("2026-09-07T09:00:00Z");

function makeSource(overrides: Partial<Quote> = {}): Quote {
  return {
    id: "src-id-0001",
    organization_id: "org-abc",
    client_id: "client-xyz",
    quote_number: "Q-2026-0001",
    plan_id: "plan-1",
    plan_name_snapshot: "Lead management",
    monthly_price_cents: 50000,
    setup_fee_cents: 50000,
    currency: "usd",
    warming_days: 21,
    launch_date: "2026-10-05T00:00:00Z",
    launch_date_mode: "derived",
    contacts_count: 1000,
    contact_sourcing_cents: 25000,
    scope_of_work: "One\nTwo",
    terms: "Net 30",
    signed_url_hash: "oldhasholdhasholdhasholdhasholdhasholdhasholdh01",
    status: "viewed",
    expires_at: "2026-09-01T00:00:00Z", // already in the past vs NOW
    sent_at: "2026-08-25T00:00:00Z",
    viewed_at: "2026-08-26T00:00:00Z",
    accepted_at: null,
    declined_at: null,
    sent_to_email: "prospect@example.com",
    sent_by: "user-1",
    accepted_by_email: null,
    accepted_ip: null,
    accepted_user_agent: null,
    stripe_checkout_session_id: null,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
    ...overrides,
  };
}

console.log("buildReissuedDraft:");

// 1) Core clone/reset from a typical sent/viewed source.
{
  const src = makeSource();
  const d = buildReissuedDraft(src, "Q-2026-0002", NOW);

  ok(d.status === "draft", "status reset to draft");
  ok(d.quote_number === "Q-2026-0002", "takes the new quote number");
  ok(d.id !== src.id && d.id.length > 0, "gets a fresh id");
  ok(
    d.signed_url_hash !== src.signed_url_hash &&
      /^[0-9a-f]{48}$/.test(d.signed_url_hash),
    "mints a new 48-char hex signed hash",
  );

  // Fresh acceptance window: exactly the default from NOW.
  const windowMs = new Date(d.expires_at!).getTime() - NOW.getTime();
  ok(
    Math.abs(windowMs - DEFAULT_QUOTE_EXPIRY_DAYS * DAY) < 1000,
    `expiry reset to ~${DEFAULT_QUOTE_EXPIRY_DAYS} days from now`,
  );

  // Priced line items + scope/terms carried verbatim.
  ok(d.monthly_price_cents === src.monthly_price_cents, "monthly carried");
  ok(d.setup_fee_cents === src.setup_fee_cents, "setup carried");
  ok(
    d.contact_sourcing_cents === src.contact_sourcing_cents,
    "contact-sourcing carried",
  );
  ok(d.contacts_count === src.contacts_count, "contacts_count carried");
  ok(d.scope_of_work === src.scope_of_work, "scope carried");
  ok(d.terms === src.terms, "terms carried");
  ok(d.currency === src.currency, "currency carried");
  ok(d.plan_id === src.plan_id, "plan_id carried");
  ok(
    d.plan_name_snapshot === src.plan_name_snapshot,
    "plan_name_snapshot carried",
  );
  ok(d.organization_id === src.organization_id, "organization carried");
  ok(d.client_id === src.client_id, "client carried");
  ok(d.sent_to_email === src.sent_to_email, "recipient email carried (pre-fill)");

  // Every lifecycle/audit field wiped clean.
  ok(d.sent_at === null, "sent_at wiped");
  ok(d.viewed_at === null, "viewed_at wiped");
  ok(d.accepted_at === null, "accepted_at wiped");
  ok(d.declined_at === null, "declined_at wiped");
  ok(d.sent_by === null, "sent_by wiped");
  ok(d.accepted_by_email === null, "accepted_by_email wiped");
  ok(d.accepted_ip === null, "accepted_ip wiped");
  ok(d.accepted_user_agent === null, "accepted_user_agent wiped");
  ok(
    d.stripe_checkout_session_id === null,
    "stripe_checkout_session_id wiped",
  );
  ok(d.created_at === NOW.toISOString(), "created_at = now");
  ok(d.updated_at === NOW.toISOString(), "updated_at = now");

  // Schedule reset to derived off NOW; launch is a future date, never the
  // source's stale one.
  ok(d.launch_date_mode === "derived", "launch mode reset to derived");
  ok(
    new Date(d.launch_date!).getTime() > NOW.getTime(),
    "launch recomputed into the future",
  );
  ok(d.warming_days >= src.warming_days, "warming >= source warming");
}

// 2) A source with a PAST fixed launch must NOT carry that stale date forward.
{
  const src = makeSource({
    status: "expired",
    launch_date_mode: "fixed",
    launch_date: "2020-01-01T00:00:00Z",
  });
  const d = buildReissuedDraft(src, "Q-2026-0003", NOW);
  ok(d.launch_date_mode === "derived", "stale fixed source -> derived draft");
  ok(
    new Date(d.launch_date!).getTime() > NOW.getTime(),
    "stale fixed launch not carried (future launch)",
  );
}

// 3) No-contacts source: 0 / null carried cleanly, not coerced.
{
  const src = makeSource({ contact_sourcing_cents: 0, contacts_count: null });
  const d = buildReissuedDraft(src, "Q-2026-0004", NOW);
  ok(d.contact_sourcing_cents === 0, "zero sourcing carried as 0");
  ok(d.contacts_count === null, "null contacts_count carried as null");
}

// 4) Randomness: two reissues of the same source get distinct ids + hashes.
{
  const src = makeSource();
  const a = buildReissuedDraft(src, "Q-2026-0005", NOW);
  const b = buildReissuedDraft(src, "Q-2026-0006", NOW);
  ok(a.id !== b.id, "distinct ids across reissues");
  ok(a.signed_url_hash !== b.signed_url_hash, "distinct signed hashes");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
