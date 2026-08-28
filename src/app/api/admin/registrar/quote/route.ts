// POST /api/admin/registrar/quote — price a domain WITHOUT buying it. Runs the
// same availability sweep the provision route does, plus the month-to-date
// spend headroom, so the provision card can show per-registrar prices and the
// remaining budget before the owner commits. Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadRegistrarConfig, configuredProviders } from "@/lib/registrar/auth";
import { sweepAvailability, monthToDateSpendUsd } from "@/lib/registrar/sweep";

interface QuoteBody {
  domain?: string;
}

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const body = (await req.json().catch(() => null)) as QuoteBody | null;
  const domain = (body?.domain ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return NextResponse.json({ error: "A valid bare domain is required (e.g. tryacme.com)." }, { status: 400 });
  }

  const admin = createAdminClient();
  const config = await loadRegistrarConfig(admin, organizationId);
  const providers = configuredProviders(config);
  if (providers.length === 0) {
    return NextResponse.json(
      { error: "No registrar is configured. Add a Porkbun or Spaceship API key in Settings first." },
      { status: 400 },
    );
  }

  const { quotes, errors } = await sweepAvailability(providers, domain);
  const monthToDateUsd = await monthToDateSpendUsd(admin, organizationId);
  const capUsd = config.spendCapUsd;
  const remainingUsd = capUsd == null ? null : Math.round((capUsd - monthToDateUsd) * 100) / 100;

  return NextResponse.json({
    domain,
    quotes: quotes.map((q) => ({
      registrar: q.provider.id,
      available: q.avail.available,
      price_usd: q.avail.priceUsd,
    })),
    errors,
    spend: { month_to_date_usd: monthToDateUsd, cap_usd: capUsd, remaining_usd: remainingUsd },
  });
}
