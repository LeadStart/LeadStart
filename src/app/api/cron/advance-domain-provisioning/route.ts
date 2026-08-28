// GET /app/api/cron/advance-domain-provisioning — runs every 10 min (vercel.json).
//
// Advances every sending domain in 'provisioning' one tick:
//   - provisioning JSONB set (an owner started the workspace flow) → run the full
//     advancer (DNS, domain add, verification, users, licenses, mailboxes, DKIM),
//     alerting the owner when a step stays stuck past its patience threshold.
//   - provisioning JSONB null (a domain bought via /provision but set up by hand,
//     or a manually-tracked domain) → DKIM-watch only: stamp dkim_verified_at and
//     flip to warming when the google._domainkey TXT goes live.
//
// The provisioning→warming flip is applied HERE, not gated by
// organizations.domain_lifecycle_enabled: a provisioning run is explicit,
// owner-initiated setup for one named domain, and without the flip its new
// mailboxes would never leave 'provisioning' and never send while the org's
// lifecycle automation stays off (its default). The flip is guarded to
// provisioning→warming only, so it can never stomp a later lifecycle state.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { loadWorkspaceAdminForOrg, type WorkspaceAdminClients } from "@/lib/google/org";
import { GoogleConfigError } from "@/lib/google/auth";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { GmailConfigError, type GmailClient } from "@/lib/gmail/client";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import type { RegistrarConfig } from "@/lib/registrar/auth";
import { checkDomainAuth } from "@/lib/deliverability/check";
import { advanceProvisioning } from "@/lib/deliverability/provisioning-runner";
import { firstIncompleteStep, markStep } from "@/lib/deliverability/provisioning";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import type { SendingDomain } from "@/types/app";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PER_TICK = 10;
// Patience before alerting on a stuck step (attempts at the 10-min cadence):
// DNS/verification propagation can legitimately take hours, so hold longer.
const ALERT_THRESHOLD_STEP: Record<string, number> = { site_verification: 72 }; // ~12h
const ALERT_THRESHOLD_DEFAULT = 6; // ~1h

interface OrgClients {
  workspace: WorkspaceAdminClients;
  gmail: GmailClient;
  config: RegistrarConfig;
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("sending_domains")
    .select("*")
    .eq("lifecycle_status", "provisioning")
    .order("created_at", { ascending: true })
    .limit(MAX_PER_TICK);

  const domains = (rows ?? []) as SendingDomain[];
  const orgCache = new Map<string, OrgClients | null>();
  const summary = { advanced: 0, dkim_watch: 0, warming: 0, alerted: 0, skipped_config: 0, errors: 0 };

  async function clientsFor(orgId: string, workspaceId: string | null): Promise<OrgClients | null> {
    const key = `${orgId}|${workspaceId ?? "default"}`;
    if (orgCache.has(key)) return orgCache.get(key) ?? null;
    let clients: OrgClients | null = null;
    try {
      const workspace = await loadWorkspaceAdminForOrg(admin, orgId, { workspaceId });
      const gmail = await loadGmailClientForOrg(admin, orgId);
      const config = await loadRegistrarConfig(admin, orgId);
      clients = { workspace, gmail, config };
    } catch (err) {
      if (!(err instanceof GoogleConfigError || err instanceof GmailConfigError)) throw err;
      clients = null; // config missing → the owner hasn't finished setup; skip.
    }
    orgCache.set(key, clients);
    return clients;
  }

  for (const domain of domains) {
    try {
      if (domain.provisioning && !domain.provisioning.completed_at) {
        const clients = await clientsFor(domain.organization_id, domain.workspace_id ?? null);
        if (!clients) {
          summary.skipped_config++;
          continue;
        }
        const registrar =
          domain.registrar === "manual" ? null : providerFor(clients.config, domain.registrar);
        const res = await advanceProvisioning(
          { admin, registrar, workspace: clients.workspace, gmail: clients.gmail, checkAuth: checkDomainAuth },
          domain,
        );
        summary.advanced++;
        if (res.became_warming) summary.warming++;
        if (await maybeAlert(admin, domain, res.state)) summary.alerted++;
      } else if (!domain.provisioning) {
        // DKIM-watch-only path.
        const authResult = await checkDomainAuth(domain.domain).catch(() => null);
        summary.dkim_watch++;
        if (authResult?.dkim.status === "pass" && !domain.dkim_verified_at) {
          const now = new Date().toISOString();
          await admin
            .from("sending_domains")
            .update({ dkim_verified_at: now, lifecycle_status: "warming", lifecycle_changed_at: now })
            .eq("id", domain.id)
            .eq("lifecycle_status", "provisioning");
          summary.warming++;
        }
      }
    } catch (err) {
      summary.errors++;
      console.error(`[advance-domain-provisioning] ${domain.domain}:`, err);
    }
  }

  return NextResponse.json({ status: domains.length ? "ok" : "idle", ...summary });
}

/**
 * Alert the owner once when the blocking step is stuck past its threshold (or
 * failed). Sets the step's `alerted` latch so it fires at most once; retries
 * keep going regardless. Returns whether an alert was enqueued.
 */
async function maybeAlert(
  admin: ReturnType<typeof createAdminClient>,
  domain: SendingDomain,
  state: NonNullable<SendingDomain["provisioning"]>,
): Promise<boolean> {
  const blockerId = firstIncompleteStep(state);
  if (!blockerId) return false;
  const step = state.steps[blockerId];
  const threshold = ALERT_THRESHOLD_STEP[blockerId] ?? ALERT_THRESHOLD_DEFAULT;
  const stuck =
    step.status === "failed" || (step.status === "in_progress" && step.attempts >= threshold);
  if (!stuck || step.alerted) return false;

  await enqueueOwnerAlert({
    admin,
    kind: "domain_provisioning",
    subject: `Domain ${domain.domain} provisioning needs attention`,
    summary: `Step "${blockerId}" is ${step.status}${step.last_error ? `: ${step.last_error}` : ""}.`,
    context: { domain: domain.domain, step: blockerId, status: step.status, attempts: step.attempts },
  });

  const now = new Date().toISOString();
  const latched = markStep(state, blockerId, { alerted: true }, now);
  await admin
    .from("sending_domains")
    .update({ provisioning: latched })
    .eq("id", domain.id)
    .eq("provisioning->>updated_at", state.updated_at);
  return true;
}
