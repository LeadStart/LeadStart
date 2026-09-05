// Availability sweep + month-to-date spend, shared by the provision route and
// the quote endpoint. Extracted so a price check ("quote") walks the exact same
// path a purchase would, minus the buy. Pure orchestration over the provider
// clients; no purchase side effects.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DomainAvailability, RegistrarProvider } from "./types";
import { monthStartIso } from "./spend";

export interface AvailabilityQuote {
  provider: RegistrarProvider;
  avail: DomainAvailability;
}

export interface SweepResult {
  /** Available registrars only, cheapest first (a null/unknown price sorts last). */
  quotes: AvailabilityQuote[];
  /** Per-provider failures (bad key, outage): one bad provider never sinks the sweep. */
  errors: string[];
}

export async function sweepAvailability(
  providers: RegistrarProvider[],
  domain: string,
): Promise<SweepResult> {
  const quotes: AvailabilityQuote[] = [];
  const errors: string[] = [];
  await Promise.all(
    providers.map(async (p) => {
      try {
        const avail = await p.checkAvailability(domain);
        if (avail.available) quotes.push({ provider: p, avail });
      } catch (err) {
        errors.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  quotes.sort((a, b) => priceOrInf(a.avail.priceUsd) - priceOrInf(b.avail.priceUsd));
  return { quotes, errors };
}

export function priceOrInf(p: number | null): number {
  return p == null || !Number.isFinite(p) ? Number.POSITIVE_INFINITY : p;
}

/**
 * Sum this month's automated domain spend for an org: the running total the
 * fail-closed cap is checked against (sending_domains rows created this month
 * with a non-null purchase_price_usd).
 */
export async function monthToDateSpendUsd(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data } = await admin
    .from("sending_domains")
    .select("purchase_price_usd")
    .eq("organization_id", organizationId)
    .gte("created_at", monthStartIso(Date.now()))
    .not("purchase_price_usd", "is", null);
  return ((data ?? []) as { purchase_price_usd: number | string | null }[]).reduce(
    (sum, r) => sum + (r.purchase_price_usd != null ? Number(r.purchase_price_usd) : 0),
    0,
  );
}
