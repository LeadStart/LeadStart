// POST /api/admin/registrar/provision: buy one domain and lay down its DNS.
//
// Flow: availability sweep across every configured registrar → pick the cheapest
// available → enforce the fail-closed monthly spend cap → register → write the
// tier's DNS records → insert a sending_domains row in 'provisioning'. Owner only.
//
// SPENDS REAL MONEY (a domain registration) when called with live keys, but
// only ever within organizations.registrar_monthly_spend_cap_usd, and only on an
// explicit owner action. No keys or no cap → it refuses before any purchase.
// The Gmail tier is wired here; the SMTP tier needs a mail host + IP (Phase 4).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRegistrarConfig, configuredProviders } from "@/lib/registrar/auth";
import { checkSpendCap } from "@/lib/registrar/spend";
import { sweepAvailability, monthToDateSpendUsd } from "@/lib/registrar/sweep";
import { gmailTierRecords } from "@/lib/registrar/dns";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { RegistrarId } from "@/lib/registrar/types";

async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return { error: NextResponse.json({ error: "No organization on user" }, { status: 400 }) };
  }
  return { organizationId };
}

export const maxDuration = 60;

interface ProvisionBody {
  domain?: string;
  tier?: "gmail" | "smtp";
  dmarcRua?: string;
  /** Force one registrar (the split selector). Omitted = buy where cheaper. */
  registrar?: RegistrarId;
}

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const body = (await request.json().catch(() => null)) as ProvisionBody | null;
  const domain = (body?.domain ?? "").trim().toLowerCase();
  const tier = body?.tier ?? "gmail";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return NextResponse.json({ error: "A valid bare domain is required (e.g. tryacme.com)." }, { status: 400 });
  }
  if (tier === "smtp") {
    return NextResponse.json(
      { error: "SMTP-tier provisioning needs a mail host + sending IP (Phase 4). Use the Gmail tier for now." },
      { status: 400 },
    );
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

  // Optional forced registrar (the split selector on the provision card).
  const requested = body?.registrar;
  let sweepProviders = providers;
  if (requested) {
    sweepProviders = providers.filter((p) => p.id === requested);
    if (sweepProviders.length === 0) {
      return NextResponse.json(
        { error: `The ${requested} registrar isn't configured. Add its API key in Settings first.` },
        { status: 400 },
      );
    }
  }

  // Availability sweep: one provider failing (bad key, outage) doesn't sink the
  // others. With a forced registrar, the sweep is just that one.
  const { quotes, errors } = await sweepAvailability(sweepProviders, domain);
  if (quotes.length === 0) {
    return NextResponse.json(
      {
        error: `${domain} isn't available to register through your ${
          requested ?? "configured"
        } registrar(s).`,
        detail: errors.length ? errors.join("; ") : undefined,
      },
      { status: 409 },
    );
  }

  // Cheapest available (the sweep already sorted; a null/unknown price sorts last).
  const chosen = quotes[0];
  const priceUsd = chosen.avail.priceUsd;
  if (priceUsd == null || !(priceUsd > 0)) {
    return NextResponse.json(
      { error: `Could not determine a registration price for ${domain}; refusing to buy blind.` },
      { status: 502 },
    );
  }

  // Fail-closed spend cap: sum this month's purchases, then decide.
  const monthToDateUsd = await monthToDateSpendUsd(admin, organizationId);
  const cap = checkSpendCap({ capUsd: config.spendCapUsd, monthToDateUsd, priceUsd });
  if (!cap.allowed) {
    // A blocked purchase is a fail-closed refusal the owner should see (mirrors
    // the Million Verifier gate's alert on an outage).
    await enqueueOwnerAlert({
      admin,
      kind: "registrar_spend_cap",
      subject: "Domain purchase blocked by the monthly spend cap",
      summary: cap.reason,
      context: {
        domain,
        registrar: chosen.provider.id,
        price_usd: priceUsd,
        month_to_date_usd: monthToDateUsd,
        cap_usd: config.spendCapUsd,
      },
    });
    return NextResponse.json({ error: cap.reason, spend: cap }, { status: 402 });
  }

  // Register, then DNS, then record the domain. If DNS write fails after a
  // successful purchase, we still record the domain (it's bought) and report the
  // DNS error so the owner can retry writing records: never lose a paid domain.
  let registeredPrice = priceUsd;
  try {
    const reg = await chosen.provider.registerDomain(domain);
    if (reg.priceUsd > 0) registeredPrice = reg.priceUsd;
  } catch (err) {
    return NextResponse.json(
      { error: `Registration failed at ${chosen.provider.id}: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  let dnsError: string | null = null;
  try {
    await chosen.provider.upsertDnsRecords(domain, gmailTierRecords({ dmarcRua: body?.dmarcRua }));
  } catch (err) {
    dnsError = err instanceof Error ? err.message : String(err);
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const expiresAt = new Date(
    Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
  const { data: inserted, error: insertError } = await admin
    .from("sending_domains")
    .insert({
      organization_id: organizationId,
      domain,
      tier: "gmail",
      lifecycle_status: "provisioning",
      registrar: chosen.provider.id as RegistrarId,
      registered_at: today,
      expires_at: expiresAt,
      purchase_price_usd: registeredPrice,
    })
    .select("*")
    .single();
  if (insertError) {
    return NextResponse.json(
      {
        error: `Domain registered at ${chosen.provider.id} but recording it failed: ${insertError.message}`,
        domain,
        registrar: chosen.provider.id,
        price_usd: registeredPrice,
        dns_error: dnsError,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    domain: inserted,
    registrar: chosen.provider.id,
    price_usd: registeredPrice,
    dns_written: dnsError == null,
    dns_error: dnsError,
    spend: cap,
  });
}
