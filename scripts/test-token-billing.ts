/**
 * Unit tests for the pure token-pricing math (no DB). Verifies the charge basis
 * (attribute-based, off delivered outcome_counts) and the worst-case hold basis.
 *
 *   npx tsx scripts/test-token-billing.ts
 */
import { tierPrice, priceDelivered, worstCaseRetailPerRow, type PricingTier } from "../src/lib/tokens/pricing-math";

let passed = 0;
let failed = 0;
function eq(name: string, got: number, want: number) {
  if (Math.abs(got - want) < 1e-9) {
    passed++;
    console.log(`  ok  ${name} = ${got}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}: got ${got}, want ${want}`);
  }
}

// Synthetic price card. Maps: company 2, owner_name 3, personal 5, verified 8,
// catch_all_recovered 6. record free, catch_all_guess bundled. LinkedIn: personal 5, verified 8.
const tiers: PricingTier[] = [
  { vein: "maps", tier_key: "record", token_price: null, is_free: true, is_bundled: false },
  { vein: "maps", tier_key: "company_inbox", token_price: 2, is_free: false, is_bundled: false },
  { vein: "maps", tier_key: "owner_name", token_price: 3, is_free: false, is_bundled: false },
  { vein: "maps", tier_key: "personal_email", token_price: 5, is_free: false, is_bundled: false },
  { vein: "maps", tier_key: "verified_personal_email", token_price: 8, is_free: false, is_bundled: false },
  { vein: "maps", tier_key: "catch_all_guess", token_price: 1, is_free: false, is_bundled: true },
  { vein: "maps", tier_key: "catch_all_recovered", token_price: 6, is_free: false, is_bundled: false },
  { vein: "linkedin", tier_key: "record", token_price: null, is_free: true, is_bundled: false },
  { vein: "linkedin", tier_key: "personal_email", token_price: 5, is_free: false, is_bundled: false },
  { vein: "linkedin", tier_key: "verified_personal_email", token_price: 8, is_free: false, is_bundled: false },
];

// tierPrice: priced vs free/bundled/unpriced/missing
eq("tierPrice maps personal", tierPrice(tiers, "maps", "personal_email"), 5);
eq("tierPrice maps record (free) = 0", tierPrice(tiers, "maps", "record"), 0);
eq("tierPrice maps catch_all_guess (bundled) = 0", tierPrice(tiers, "maps", "catch_all_guess"), 0);
eq("tierPrice maps unknown = 0", tierPrice(tiers, "maps", "nope"), 0);
eq("tierPrice linkedin owner_name (missing) = 0", tierPrice(tiers, "linkedin", "owner_name"), 0);

// priceDelivered: attribute-based sum. record/phone/catch_all_email not charged.
// counts: company_email 2, owner_name 1, personal_email 3, verified_email 3 → 2*2 + 1*3 + 3*5 + 3*8 = 4+3+15+24 = 46
eq(
  "priceDelivered maps full",
  priceDelivered(tiers, "maps", { record: 10, phone: 4, company_email: 2, owner_name: 1, personal_email: 3, verified_email: 3, catch_all_email: 5 }),
  46,
);
// only company inboxes: 4 * 2 = 8
eq("priceDelivered maps company only", priceDelivered(tiers, "maps", { record: 4, company_email: 4 }), 8);
// nothing billable (only free record + phone)
eq("priceDelivered maps free only = 0", priceDelivered(tiers, "maps", { record: 9, phone: 9 }), 0);
// linkedin: personal 2, verified 2 → 2*5 + 2*8 = 26
eq("priceDelivered linkedin", priceDelivered(tiers, "linkedin", { record: 5, personal_email: 2, verified_email: 2 }), 26);

// worstCaseRetailPerRow: max(personalLoad, company, catch_all_recovered)
// maps personalLoad = 3+5+8 = 16 vs company 2 vs catch_all_recovered 6 → 16
eq("worstCase maps = 16", worstCaseRetailPerRow(tiers, "maps"), 16);
// linkedin personalLoad = 0+5+8 = 13 (no owner_name) vs company 0 vs recovered 0 → 13
eq("worstCase linkedin = 13", worstCaseRetailPerRow(tiers, "linkedin"), 13);
// unpriced vein → 0 (gates the search)
eq("worstCase empty vein = 0", worstCaseRetailPerRow([], "maps"), 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
