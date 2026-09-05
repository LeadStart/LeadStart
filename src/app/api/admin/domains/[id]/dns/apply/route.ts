// POST /api/admin/domains/[id]/dns/apply: (re)write the Gmail-tier DNS records
// at the registrar. This is the recovery for a provision that returned
// dns_written:false, and the way to (re)lay the tier records + site-verification
// TXT. For a manual registrar there's nothing to write, so it returns the
// records for the owner to copy-paste. Owner only, org-scoped.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import type { SendingDomain } from "@/types/app";
import { expectedRecords } from "../route";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: domain } = await admin
    .from("sending_domains")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!domain) {
    return NextResponse.json({ error: "Domain not found" }, { status: 404 });
  }
  const d = domain as SendingDomain;
  const records = expectedRecords(d);

  if (d.registrar === "manual") {
    return NextResponse.json({ applied: false, manual: true, records });
  }

  const config = await loadRegistrarConfig(admin, organizationId);
  const provider = providerFor(config, d.registrar);
  if (!provider) {
    return NextResponse.json(
      { error: `The ${d.registrar} registrar isn't configured. Add its API key in Settings.`, records },
      { status: 400 },
    );
  }

  try {
    await provider.upsertDnsRecords(d.domain, records);
  } catch (err) {
    return NextResponse.json(
      { error: `Writing DNS failed at ${d.registrar}: ${err instanceof Error ? err.message : String(err)}`, records },
      { status: 502 },
    );
  }
  return NextResponse.json({ applied: true, records });
}
