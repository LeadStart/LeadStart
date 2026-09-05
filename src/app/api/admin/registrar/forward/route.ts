// URL forwarding (redirects) for a tracked sending domain.
//   GET  ?domain=acme.com : read the current forwarding state
//   POST { domain, destinationUrl, www?, includePath? }: set the redirect
//
// A lookalike sending domain usually 301-redirects its bare hostname to the
// client's real site so it never shows a dead parked page. Porkbun sets this
// over its API; Spaceship has no forwarding API (dashboard-only) and a 'manual'
// registrar means hand-managed DNS: both return manual instructions instead of
// pushing. Owner only, org-scoped. Spends no money.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import {
  ManualForwardingRequiredError,
  defaultForwards,
  manualForwardingMessage,
  normalizeDestinationUrl,
} from "@/lib/registrar/forwarding";
import type { RegistrarId } from "@/lib/registrar/types";

export const maxDuration = 30;

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Find the tracked domain's registrar within the owner's org, or null. */
async function registrarForDomain(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  domain: string,
): Promise<"porkbun" | "spaceship" | "manual" | null> {
  const { data } = await admin
    .from("sending_domains")
    .select("registrar")
    .eq("organization_id", organizationId)
    .eq("domain", domain)
    .maybeSingle();
  const r = (data as { registrar?: string } | null)?.registrar;
  return r === "porkbun" || r === "spaceship" || r === "manual" ? r : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const domain = (request.nextUrl.searchParams.get("domain") ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    return NextResponse.json({ error: "A valid domain query param is required." }, { status: 400 });
  }

  const admin = createAdminClient();
  const registrar = await registrarForDomain(admin, auth.organizationId, domain);
  if (!registrar) {
    return NextResponse.json({ error: `${domain} isn't a tracked sending domain.` }, { status: 404 });
  }

  // Manual-DNS domain: nothing to read from an API.
  if (registrar === "manual") {
    return NextResponse.json({
      domain,
      registrar,
      supported: false,
      manual: true,
      instructions: manualForwardingMessage("manual"),
      forwards: [],
    });
  }

  const config = await loadRegistrarConfig(admin, auth.organizationId);
  const provider = providerFor(config, registrar as RegistrarId);
  if (!provider) {
    return NextResponse.json({
      domain,
      registrar,
      supported: false,
      configured: false,
      error: `No ${registrar} API key is saved. Add it in Settings to manage forwarding.`,
      forwards: [],
    });
  }
  if (!provider.supportsUrlForwarding) {
    return NextResponse.json({
      domain,
      registrar,
      supported: false,
      manual: true,
      instructions: manualForwardingMessage(registrar),
      forwards: [],
    });
  }

  try {
    const forwards = await provider.getUrlForwards(domain);
    return NextResponse.json({ domain, registrar, supported: true, forwards });
  } catch (err) {
    if (err instanceof ManualForwardingRequiredError) {
      return NextResponse.json({
        domain,
        registrar,
        supported: false,
        manual: true,
        instructions: err.message,
        forwards: [],
      });
    }
    return NextResponse.json(
      { domain, registrar, supported: true, forwards: [], error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

interface SetBody {
  domain?: string;
  destinationUrl?: string;
  www?: boolean;
  includePath?: boolean;
}

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => null)) as SetBody | null;
  const domain = (body?.domain ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    return NextResponse.json({ error: "A valid domain is required." }, { status: 400 });
  }
  const location = normalizeDestinationUrl(body?.destinationUrl ?? "");
  if (!location) {
    return NextResponse.json(
      { error: "A valid destination URL is required (e.g. https://acme.com)." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const registrar = await registrarForDomain(admin, auth.organizationId, domain);
  if (!registrar) {
    return NextResponse.json({ error: `${domain} isn't a tracked sending domain.` }, { status: 404 });
  }

  // Manual-DNS domain: report the manual step, nothing to push.
  if (registrar === "manual") {
    return NextResponse.json({
      domain,
      registrar,
      supported: false,
      manual: true,
      instructions: manualForwardingMessage("manual"),
      destination: location,
    });
  }

  const config = await loadRegistrarConfig(admin, auth.organizationId);
  const provider = providerFor(config, registrar as RegistrarId);
  if (!provider) {
    return NextResponse.json(
      { error: `No ${registrar} API key is saved. Add it in Settings first.` },
      { status: 400 },
    );
  }
  if (!provider.supportsUrlForwarding) {
    return NextResponse.json({
      domain,
      registrar,
      supported: false,
      manual: true,
      instructions: manualForwardingMessage(registrar),
      destination: location,
    });
  }

  const desired = defaultForwards(location, { www: body?.www, includePath: body?.includePath });
  try {
    await provider.setUrlForwards(domain, desired);
    const forwards = await provider.getUrlForwards(domain);
    return NextResponse.json({ domain, registrar, supported: true, destination: location, forwards });
  } catch (err) {
    if (err instanceof ManualForwardingRequiredError) {
      return NextResponse.json({
        domain,
        registrar,
        supported: false,
        manual: true,
        instructions: err.message,
        destination: location,
      });
    }
    return NextResponse.json(
      { error: `Setting forwarding failed at ${registrar}: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
