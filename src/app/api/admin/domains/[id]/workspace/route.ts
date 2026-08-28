// POST /api/admin/domains/[id]/workspace — start Google Workspace provisioning
// for a domain in 'provisioning': add it to the tenant, mint + write the
// site-verification TXT, create 1-3 users, (optionally) license them, and
// register their mailboxes. Runs every step that doesn't need to wait inline;
// the rest advance in the cron / Check-now. Passwords are returned ONCE and
// never stored. Owner only, org-scoped.
//
// Note: no Gmail send-as / signature step — our MIME builder writes the From
// header (display name) on every send, so a server-side alias would never be read.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadWorkspaceAdminForOrg } from "@/lib/google/org";
import { GoogleConfigError } from "@/lib/google/auth";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import { gmailTierRecords } from "@/lib/registrar/dns";
import { checkDomainAuth } from "@/lib/deliverability/check";
import { initProvisioningState } from "@/lib/deliverability/provisioning";
import { advanceProvisioning } from "@/lib/deliverability/provisioning-runner";
import type { SendingDomain } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface WorkspaceBody {
  users?: { local_part?: string; display_name?: string }[];
  licensing?: { product_id?: string; sku_id?: string } | null;
  dmarc_rua?: string;
  /** Which Google Workspace to provision into; omitted = the org's default. */
  workspace_id?: string;
}

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as WorkspaceBody | null;

  // Validate the inbox specs: 1-3 users, valid local parts, deduped.
  const rawUsers = Array.isArray(body?.users) ? body!.users : [];
  const seen = new Set<string>();
  const users: { local_part: string; display_name: string }[] = [];
  for (const u of rawUsers) {
    const local = (u?.local_part ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,40}$/.test(local)) {
      return NextResponse.json(
        { error: `Invalid mailbox name "${u?.local_part ?? ""}". Use letters, numbers, dot, dash, underscore.` },
        { status: 400 },
      );
    }
    if (seen.has(local)) continue;
    seen.add(local);
    users.push({ local_part: local, display_name: (u?.display_name ?? "").trim() || local });
  }
  if (users.length === 0 || users.length > 3) {
    return NextResponse.json(
      { error: "Provide 1 to 3 mailboxes (3 inboxes/domain is the volume ceiling)." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: domainRow } = await admin
    .from("sending_domains")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!domainRow) {
    return NextResponse.json({ error: "Domain not found" }, { status: 404 });
  }
  const domain = domainRow as SendingDomain;
  if (domain.tier !== "gmail") {
    return NextResponse.json({ error: "Workspace provisioning is for Gmail-tier domains." }, { status: 400 });
  }
  if (domain.lifecycle_status !== "provisioning") {
    return NextResponse.json(
      { error: `Domain is '${domain.lifecycle_status}', not 'provisioning'.` },
      { status: 400 },
    );
  }
  if (domain.provisioning) {
    return NextResponse.json(
      { error: "Provisioning already started for this domain. Use Check now to advance it." },
      { status: 409 },
    );
  }

  // Load the Workspace admin clients for the chosen (or default) Workspace
  // (config errors are actionable 400s).
  let workspace;
  try {
    workspace = await loadWorkspaceAdminForOrg(admin, organizationId, {
      workspaceId: body?.workspace_id ?? domain.workspace_id ?? null,
    });
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  const gmail = await loadGmailClientForOrg(admin, organizationId);
  const config = await loadRegistrarConfig(admin, organizationId);
  const registrar = domain.registrar === "manual" ? null : providerFor(config, domain.registrar);

  // Init the state and persist it first (guarded on still-null) so the runner's
  // CAS write has a row clock to match.
  const now = new Date().toISOString();
  const initState = initProvisioningState({
    now,
    domain: domain.domain,
    users,
    licensing:
      body?.licensing?.product_id && body?.licensing?.sku_id
        ? { product_id: body.licensing.product_id, sku_id: body.licensing.sku_id }
        : workspace.licensingDefaults
          ? { product_id: workspace.licensingDefaults.productId, sku_id: workspace.licensingDefaults.skuId }
          : null,
    dmarcRua: body?.dmarc_rua?.trim() || null,
  });

  const { data: claimed } = await admin
    .from("sending_domains")
    .update({ provisioning: initState, workspace_id: workspace.workspaceId })
    .eq("id", domain.id)
    .is("provisioning", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    return NextResponse.json(
      { error: "Provisioning was just started elsewhere. Use Check now to advance it." },
      { status: 409 },
    );
  }

  const res = await advanceProvisioning(
    { admin, registrar, workspace, gmail, checkAuth: checkDomainAuth },
    { ...domain, provisioning: initState },
  );

  // For a manual registrar, hand back the records the owner must add by hand.
  const manualDns =
    registrar == null
      ? [
          ...gmailTierRecords({ dmarcRua: initState.dmarc_rua ?? undefined }),
          ...(res.state.site_verification_token
            ? [{ type: "TXT" as const, name: "", content: res.state.site_verification_token }]
            : []),
        ]
      : undefined;

  return NextResponse.json({
    provisioning: res.state,
    advanced: res.advanced,
    revealed_passwords: res.revealed_passwords,
    became_warming: res.became_warming,
    manual_dns: manualDns,
  });
}
