// POST /api/admin/registrar/suggest: brand → available lookalike domains. Runs
// the lookalike-name generator (try{brand}.com, get{brand}.com, {brand}hq.com…)
// and checks each for availability + cheapest price across the configured
// registrars, so the provision card can offer real, buyable candidates.
// Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadRegistrarConfig, configuredProviders } from "@/lib/registrar/auth";
import { sweepAvailability } from "@/lib/registrar/sweep";
import { generateLookalikeDomains } from "@/lib/registrar/names";

interface SuggestBody {
  brand?: string;
  tlds?: string[];
  limit?: number;
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const body = (await req.json().catch(() => null)) as SuggestBody | null;
  const brand = (body?.brand ?? "").trim();
  if (!brand) {
    return NextResponse.json({ error: "A brand name is required." }, { status: 400 });
  }
  const limit = Math.min(Math.max(Math.floor(body?.limit ?? 8), 1), 10);
  const tlds = Array.isArray(body?.tlds) && body!.tlds!.length ? body!.tlds : undefined;

  const admin = createAdminClient();
  const config = await loadRegistrarConfig(admin, organizationId);
  const providers = configuredProviders(config);
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "No registrar is configured. Add a Porkbun or Spaceship API key in Settings first." },
      { status: 400 },
    );
  }

  const candidates = generateLookalikeDomains({ brand, limit, tlds });
  const results = await Promise.all(
    candidates.map(async (domain) => {
      const { quotes } = await sweepAvailability(providers, domain);
      const best = quotes[0];
      return {
        domain,
        available: !!best,
        best_price_usd: best ? best.avail.priceUsd : null,
        registrar: best ? best.provider.id : null,
      };
    }),
  );

  return NextResponse.json({ brand, candidates: results });
}
