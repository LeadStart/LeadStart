// GET /api/admin/domains/[id]/dns: the DNS panel for one sending domain:
//   expected         the records this Gmail-tier domain should have (Google MX,
//                    SPF, DMARC, plus the site-verification TXT once minted)
//   registrar_records what the registrar currently has (first real caller of the
//                    provider getDnsRecords; null for a manual registrar)
//   live             a live SPF/DKIM/DMARC/MX probe (checkDomainAuth/checkMx)
// Owner only, org-scoped.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import { gmailTierRecords } from "@/lib/registrar/dns";
import { checkDomainAuth, checkMx } from "@/lib/deliverability/check";
import type { DnsRecordInput } from "@/lib/registrar/types";
import type { SendingDomain } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export function expectedRecords(domain: SendingDomain): DnsRecordInput[] {
  const records = gmailTierRecords({ dmarcRua: domain.provisioning?.dmarc_rua ?? undefined });
  const token = domain.provisioning?.site_verification_token;
  if (token) {
    records.push({ type: "TXT", name: "", content: token });
  }
  return records;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
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

  // Registrar read-back (skipped for manual / unconfigured).
  let registrarRecords: DnsRecordInput[] | null = null;
  let registrarError: string | null = null;
  if (d.registrar !== "manual") {
    const config = await loadRegistrarConfig(admin, organizationId);
    const provider = providerFor(config, d.registrar);
    if (provider) {
      try {
        registrarRecords = await provider.getDnsRecords(d.domain);
      } catch (err) {
        registrarError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Live DNS probe (best-effort; failures surface as fail statuses inside).
  const [authResult, mx] = await Promise.all([
    checkDomainAuth(d.domain).catch(() => null),
    checkMx(d.domain).catch(() => null),
  ]);

  return NextResponse.json({
    domain: d.domain,
    registrar: d.registrar,
    expected: expectedRecords(d),
    registrar_records: registrarRecords,
    registrar_error: registrarError,
    live: { auth: authResult, mx },
  });
}
