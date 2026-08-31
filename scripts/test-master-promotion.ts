/**
 * Phase 4 master-pool PROMOTION harness (integration, self-cleaning).
 *
 * Exercises the REAL promotion code path (src/lib/tokens/promotion.ts →
 * promote_master_contacts RPC) against the live DB with run-unique fixtures, then
 * deletes every fixture in a finally block so the pool is left exactly as found.
 * Spends no money (DB only). Proves the Phase 2 acceptance:
 *   - a delivered buyer contact is PROMOTED into master_contacts + OWNED once
 *   - re-running is idempotent (ownership granted once)
 *   - an unkeyable contact is skipped
 *   - an AGENCY search (no token hold) is a clean no-op
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/test-master-promotion.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { promoteSearchContacts, naturalKeyFor } from "../src/lib/tokens/promotion";
import { segmentForQuery } from "../src/lib/tokens/segment";

function loadEnvLocal(): Record<string, string> {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

async function main() {
  // ---- Part A: naturalKeyFor (pure) ----
  ok("naturalKey place wins over li+email",
    naturalKeyFor({ google_place_id: "ChIJ_x", linkedin_url: "https://LinkedIn.com/in/x/", email: "A@B.com" }) === "place:ChIJ_x");
  ok("naturalKey li lowercased + trailing-slash stripped",
    naturalKeyFor({ google_place_id: null, linkedin_url: "https://LinkedIn.com/in/X/", email: "A@B.com" }) === "li:https://linkedin.com/in/x");
  ok("naturalKey email fallback lowercased",
    naturalKeyFor({ google_place_id: null, linkedin_url: null, email: " Person@Promo.COM " }) === "email:person@promo.com");
  ok("naturalKey null when unkeyable",
    naturalKeyFor({ google_place_id: null, linkedin_url: null, email: null }) === null);

  const env = loadEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- Part B: live integration (self-cleaning) ----
  const tag = randomUUID().slice(0, 8);
  const placeKey = `place:TESTPLACE_${tag}`;
  const emailKey = `email:person_${tag}@promo.test`;
  const searchId = randomUUID(); // buyer search (will carry a hold)
  const agencySearchId = randomUUID(); // no hold
  let orgId: string | null = null;
  let cleanupSegKey: string | null = null;

  try {
    // fixture org
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .insert({ name: `ZZZ_promo_test_${tag}` })
      .select("id")
      .single();
    if (orgErr) throw new Error(`org insert: ${orgErr.message}`);
    orgId = (orgRow as { id: string }).id;

    // buyer hold on searchId (the gate signal)
    const { error: holdErr } = await admin.from("token_ledger").insert({
      organization_id: orgId,
      entry_type: "hold",
      tokens: 100,
      search_id: searchId,
      search_kind: "maps",
    });
    if (holdErr) throw new Error(`hold insert: ${holdErr.message}`);

    // 3 delivered contacts: place-keyed, email-keyed, and unkeyable
    const { data: cRows, error: cErr } = await admin
      .from("contacts")
      .insert([
        { organization_id: orgId, company_name: "Promo Test Co", company_email: `info_${tag}@promo.test`, google_place_id: `TESTPLACE_${tag}`, source: "maps-prospecting" },
        { organization_id: orgId, first_name: "Pat", email: `person_${tag}@promo.test`, email_verification_status: "ok", source: "maps-prospecting" },
        { organization_id: orgId, company_name: "Unkeyable Co", source: "maps-prospecting" },
      ])
      .select("id");
    if (cErr) throw new Error(`contacts insert: ${cErr.message}`);
    const contactIds = ((cRows as { id: string }[]) ?? []).map((r) => r.id);
    ok("fixture: 3 contacts created", contactIds.length === 3, contactIds.length);

    // buyer maps_searches row so promotion can derive the SEGMENT from its query
    const searchQuery = { levers: { searchTerms: ["dentist"], areas: [{ level: "city", name: "Austin", state: "Texas" }] } };
    const expectedSeg = segmentForQuery("maps", searchQuery);
    cleanupSegKey = expectedSeg?.key ?? null;
    const { data: profRow } = await admin.from("profiles").select("id").limit(1).single();
    const creatorId = (profRow as { id: string }).id;
    const { error: sErr } = await admin.from("maps_searches").insert({
      id: searchId,
      organization_id: orgId,
      created_by: creatorId,
      query: searchQuery,
      results: [],
      result_count: 0,
      target_max_results: 100,
      status: "complete",
      actor: "compass~google-maps-extractor",
    });
    if (sErr) throw new Error(`maps_searches insert: ${sErr.message}`);
    ok("fixture: segment derivable (austin, texas)", expectedSeg !== null && expectedSeg.area === "austin, texas", expectedSeg);

    // ---- promote (first pass) ----
    const r1 = await promoteSearchContacts(admin, { searchId, searchKind: "maps", contactIds });
    ok("promotion ran (buyer search)", r1 !== null, r1);
    ok("candidates = 3", r1?.candidates === 3, r1);
    ok("promoted = 2 (unkeyable skipped)", r1?.promoted === 2, r1);
    ok("granted = 2 (owned once)", r1?.granted === 2, r1);
    ok("promotion tagged the segment", r1?.segmentKey === expectedSeg?.key, { got: r1?.segmentKey, want: expectedSeg?.key });

    const { count: segOwn } = await admin
      .from("contact_ownership")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("segment_key", expectedSeg?.key ?? "");
    ok("both ownership rows tagged with segment_key", segOwn === 2, segOwn);
    const { data: sp } = await admin
      .from("segment_pulls")
      .select("master_contact_count, terms, area")
      .eq("segment_key", expectedSeg?.key ?? "")
      .maybeSingle();
    ok("segment_pulls records M=2 for the segment", (sp as { master_contact_count?: number } | null)?.master_contact_count === 2, sp);

    // coverage read — exactly what the buyer searches route surfaces (N of ~M):
    const covOwned = segOwn ?? 0;
    const covAvail = (sp as { master_contact_count?: number } | null)?.master_contact_count ?? 0;
    ok("coverage readout resolves to 'you own 2 of ~2'", covOwned === 2 && covAvail === 2, { owned: covOwned, available: covAvail });

    const { data: mRows } = await admin
      .from("master_contacts")
      .select("id, natural_key, best_tier, company_name, email")
      .in("natural_key", [placeKey, emailKey]);
    ok("master pool holds both keyed rows", (mRows as unknown[])?.length === 2, mRows);

    const { count: ownCount } = await admin
      .from("contact_ownership")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    ok("buyer owns exactly 2 master rows", ownCount === 2, ownCount);

    // ---- promote (second pass) — idempotent ----
    const r2 = await promoteSearchContacts(admin, { searchId, searchKind: "maps", contactIds });
    ok("re-promotion grants 0 (idempotent)", r2?.granted === 0, r2);
    const { count: ownCount2 } = await admin
      .from("contact_ownership")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    ok("ownership still exactly 2 after re-run", ownCount2 === 2, ownCount2);
    const { count: masterAfter } = await admin
      .from("master_contacts")
      .select("id", { count: "exact", head: true })
      .in("natural_key", [placeKey, emailKey]);
    ok("master rows still exactly 2 after re-run (merge, no dup)", masterAfter === 2, masterAfter);

    // ---- agency no-op ----
    const rA = await promoteSearchContacts(admin, { searchId: agencySearchId, searchKind: "maps", contactIds });
    ok("agency search (no hold) is a no-op (null)", rA === null, rA);
  } finally {
    // ---- teardown: delete every fixture; leave the pool as found ----
    if (orgId) {
      await admin.from("contact_ownership").delete().eq("organization_id", orgId);
      await admin.from("master_contacts").delete().in("natural_key", [placeKey, emailKey]);
      if (cleanupSegKey) await admin.from("segment_pulls").delete().eq("segment_key", cleanupSegKey);
      await admin.from("maps_searches").delete().eq("organization_id", orgId);
      await admin.from("token_ledger").delete().eq("organization_id", orgId);
      await admin.from("contacts").delete().eq("organization_id", orgId);
      await admin.from("organizations").delete().eq("id", orgId);

      const { data: leftM } = await admin.from("master_contacts").select("id").in("natural_key", [placeKey, emailKey]);
      ok("teardown: test master rows removed", (leftM as unknown[])?.length === 0, leftM);
      const { count: leftOwn } = await admin
        .from("contact_ownership")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId);
      ok("teardown: test ownership removed", (leftOwn ?? 0) === 0, leftOwn);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
