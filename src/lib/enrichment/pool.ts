// The weak-email-host pool (owner ruling 2026-09-25). Google-Maps firms whose
// email runs on a host where our guessed addresses rarely verify (security
// gateways, GoDaddy, other small hosts, no mail server: 17% became TuBe-ready vs
// 44% on Microsoft 365 / Google) are imported but SET ASIDE:
//
//   • tagged POOL_TAG and never enriched by the automatic path (enqueueEnrichment)
//   • never attached to a campaign, even when the import picked one
//   • refused by every "add to campaign" path, and the native sender fails any
//     enrollment that still slips through
//
// Release = Contacts → select them → Enrich (contacts/enrich/start), which swaps
// POOL_TAG for POOL_RELEASED_TAG so they flow like any other lead from then on.
//
// Pure: no I/O, safe on the client.

export const POOL_TAG = "pooled-weak-host";
export const POOL_RELEASED_TAG = "pool-released";
export const POOL_SKIP_REASON =
  "Set aside in the weak-email-host pool. Release it first (Contacts → Enrich).";

export function isPooled(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes(POOL_TAG);
}

/** The contact's tags with the pool tag added (deduped). */
export function withPoolTag(tags: string[] | null | undefined): string[] {
  return Array.from(new Set([...(tags ?? []), POOL_TAG]));
}

/** The contact's tags after release: pool tag swapped for the released marker. */
export function withPoolReleased(tags: string[] | null | undefined): string[] {
  return Array.from(new Set([...(tags ?? []).filter((t) => t !== POOL_TAG), POOL_RELEASED_TAG]));
}
