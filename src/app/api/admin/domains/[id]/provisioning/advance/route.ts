// POST /api/admin/domains/[id]/provisioning/advance: "Check now". Forces one
// provisioning advance (resetting any failed step to retry). For a domain with
// no provisioning state (a manually-tracked or backfilled domain) it runs the
// DKIM-watch path only: a live DKIM probe that stamps dkim_verified_at and flips
// the domain to warming when it lands. Owner only, org-scoped.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadWorkspaceAdminForOrg } from "@/lib/google/org";
import { GoogleConfigError } from "@/lib/google/auth";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import { checkDomainAuth } from "@/lib/deliverability/check";
import { advanceProvisioning } from "@/lib/deliverability/provisioning-runner";
import type { SendingDomain } from "@/types/app";

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

  // DKIM-watch-only path for a domain with no provisioning flow.
  if (!domain.provisioning) {
    const authResult = await checkDomainAuth(domain.domain).catch(() => null);
    let becameWarming = false;
    if (
      authResult?.dkim.status === "pass" &&
      !domain.dkim_verified_at &&
      domain.lifecycle_status === "provisioning"
    ) {
      const now = new Date().toISOString();
      await admin
        .from("sending_domains")
        .update({ dkim_verified_at: now, lifecycle_status: "warming", lifecycle_changed_at: now })
        .eq("id", domain.id)
        .eq("lifecycle_status", "provisioning");
      becameWarming = true;
    }
    return NextResponse.json({
      mode: "dkim_watch",
      dkim_status: authResult?.dkim.status ?? "unknown",
      became_warming: becameWarming,
    });
  }

  // Full provisioning advance, on the domain's chosen Workspace.
  let workspace;
  try {
    workspace = await loadWorkspaceAdminForOrg(admin, organizationId, {
      workspaceId: domain.workspace_id ?? null,
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

  const res = await advanceProvisioning(
    { admin, registrar, workspace, gmail, checkAuth: checkDomainAuth },
    domain,
    { resetFailed: true },
  );

  return NextResponse.json({
    mode: "advance",
    provisioning: res.state,
    advanced: res.advanced,
    revealed_passwords: res.revealed_passwords,
    became_warming: res.became_warming,
  });
}
