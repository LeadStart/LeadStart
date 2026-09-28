// /api/admin/domains/[id]/workspace: create Google Workspace inboxes on a
// sending domain. inboxSetupEligibility decides which kind of run:
//   setup        a domain in 'provisioning' that was never set up: add it to the
//                tenant, mint + write the site-verification TXT, create the
//                users, (optionally) license them, register their mailboxes,
//                then watch for DKIM.
//   add_inboxes  a domain that is already set up (warming / active, or its setup
//                finished and only DKIM is pending): confirm live that it is on
//                the Workspace, then create, license and register the new users
//                only. DNS is never touched.
//
// POST starts the run and executes every step that doesn't need to wait inline;
// the rest advance in the cron / Check-now. Passwords are returned ONCE and
// never stored.
// GET is the wizard's preflight for a picked domain + Workspace: eligibility,
// the live "is the domain on this Workspace" check and the existing inbox
// count, so a bad pick fails before the owner names inboxes.
// Owner only, org-scoped.
//
// Note: no Gmail send-as / signature step, our MIME builder writes the From
// header (display name) on every send, so a server-side alias would never be read.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadWorkspaceAdminForOrg, type WorkspaceAdminClients } from "@/lib/google/org";
import { GoogleConfigError, GoogleRateLimitError, GoogleTransientError } from "@/lib/google/auth";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { loadRegistrarConfig, providerFor } from "@/lib/registrar/auth";
import { gmailTierRecords } from "@/lib/registrar/dns";
import { checkDomainAuth } from "@/lib/deliverability/check";
import {
  MAX_INBOXES_PER_DOMAIN,
  inboxSetupEligibility,
  initAddInboxesState,
  initProvisioningState,
} from "@/lib/deliverability/provisioning";
import { advanceProvisioning } from "@/lib/deliverability/provisioning-runner";
import type { SendingDomain } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface WorkspaceBody {
  users?: { local_part?: string; display_name?: string; given_name?: string; family_name?: string }[];
  licensing?: { product_id?: string; sku_id?: string } | null;
  dmarc_rua?: string;
  /** Which Google Workspace to provision into; omitted = the org's default. A
   *  domain already set up on a Workspace always stays on that one. */
  workspace_id?: string;
}

export const maxDuration = 60;

type AdminClient = ReturnType<typeof createAdminClient>;

async function loadDomain(
  admin: AdminClient,
  id: string,
  organizationId: string,
): Promise<SendingDomain | null> {
  const { data } = await admin
    .from("sending_domains")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as SendingDomain | null) ?? null;
}

async function countInboxes(admin: AdminClient, domainId: string): Promise<number> {
  const { count } = await admin
    .from("native_mailboxes")
    .select("id", { count: "exact", head: true })
    .eq("domain_id", domainId);
  return count ?? 0;
}

/**
 * Is the domain on this Workspace's tenant, and verified there? Lists the
 * tenant's domains rather than calling domains.get, which answers 403 (not 404)
 * for a domain owned by another Google account and would read as a
 * permissions failure.
 */
async function domainOnWorkspace(
  workspace: WorkspaceAdminClients,
  domain: string,
): Promise<{ ok: true; verified: boolean } | { ok: false; status: number; error: string }> {
  let domains: { domainName: string; verified: boolean }[];
  try {
    domains = await workspace.directory.listDomains();
  } catch (err) {
    const transient = err instanceof GoogleRateLimitError || err instanceof GoogleTransientError;
    return {
      ok: false,
      status: transient ? 502 : 400,
      error: `Couldn't read the domains on the Google Workspace managed by ${workspace.adminEmail}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const hit = domains.find((d) => d.domainName === domain);
  if (!hit) {
    return {
      ok: false,
      status: 400,
      error:
        `${domain} isn't on the Google Workspace managed by ${workspace.adminEmail}, so LeadStart can't ` +
        `create inboxes for it there. If its inboxes live on another Google account, add that Workspace ` +
        `in this wizard's Workspace step, have its admin authorize LeadStart's service account, then pick it.`,
    };
  }
  return { ok: true, verified: hit.verified };
}

/** The Workspace a run on this domain uses: the one it was set up on, else the pick. */
function workspaceIdFor(
  domain: SendingDomain,
  mode: "setup" | "add_inboxes",
  picked: string | null | undefined,
): string | null {
  if (mode === "add_inboxes" && domain.workspace_id) return domain.workspace_id;
  return picked ?? domain.workspace_id ?? null;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const admin = createAdminClient();
  const domain = await loadDomain(admin, id, organizationId);
  if (!domain) {
    return NextResponse.json({ error: "Domain not found" }, { status: 404 });
  }

  const existingInboxes = await countInboxes(admin, domain.id);
  const eligibility = inboxSetupEligibility(domain, existingInboxes);
  if (!eligibility.ok) {
    return NextResponse.json({ ok: false, reason: eligibility.reason, existing_inboxes: existingInboxes });
  }
  // A first setup adds the domain to the Workspace itself: nothing to check yet.
  if (eligibility.mode === "setup") {
    return NextResponse.json({ ok: true, mode: "setup", existing_inboxes: existingInboxes });
  }

  let workspace: WorkspaceAdminClients;
  try {
    workspace = await loadWorkspaceAdminForOrg(admin, organizationId, {
      workspaceId: workspaceIdFor(domain, "add_inboxes", req.nextUrl.searchParams.get("workspace_id")),
    });
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      return NextResponse.json({
        ok: false,
        mode: "add_inboxes",
        reason: err.message,
        existing_inboxes: existingInboxes,
      });
    }
    throw err;
  }
  const onWs = await domainOnWorkspace(workspace, domain.domain);
  return NextResponse.json({
    ok: onWs.ok,
    mode: "add_inboxes",
    reason: onWs.ok ? null : onWs.error,
    existing_inboxes: existingInboxes,
    workspace_id: workspace.workspaceId,
  });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as WorkspaceBody | null;

  // Validate the inbox specs: 1 to MAX_INBOXES_PER_DOMAIN users, valid local
  // parts, deduped.
  const rawUsers = Array.isArray(body?.users) ? body!.users : [];
  const seen = new Set<string>();
  const users: { local_part: string; display_name: string; given_name?: string; family_name?: string }[] = [];
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
    const given = (u?.given_name ?? "").trim();
    const family = (u?.family_name ?? "").trim();
    const display = (u?.display_name ?? "").trim() || [given, family].filter(Boolean).join(" ") || local;
    users.push({
      local_part: local,
      display_name: display,
      given_name: given || undefined,
      family_name: family || undefined,
    });
  }
  if (users.length === 0 || users.length > MAX_INBOXES_PER_DOMAIN) {
    return NextResponse.json(
      {
        error: `Provide 1 to ${MAX_INBOXES_PER_DOMAIN} mailboxes: a domain holds at most ${MAX_INBOXES_PER_DOMAIN} inboxes.`,
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const domain = await loadDomain(admin, id, organizationId);
  if (!domain) {
    return NextResponse.json({ error: "Domain not found" }, { status: 404 });
  }
  const existing = await countInboxes(admin, domain.id);
  const eligibility = inboxSetupEligibility(domain, existing);
  if (!eligibility.ok) {
    return NextResponse.json(
      { error: eligibility.reason },
      { status: domain.tier === "gmail" ? 409 : 400 },
    );
  }
  const mode = eligibility.mode;

  // The hard cap counts the inboxes the domain already has, and a name that is
  // already an inbox is refused rather than silently adopted.
  if (existing + users.length > MAX_INBOXES_PER_DOMAIN) {
    const left = MAX_INBOXES_PER_DOMAIN - existing;
    return NextResponse.json(
      {
        error:
          `${domain.domain} has ${existing} inbox${existing === 1 ? "" : "es"}, so it can take ${left} more ` +
          `(a domain holds at most ${MAX_INBOXES_PER_DOMAIN}).`,
      },
      { status: 400 },
    );
  }
  const emails = users.map((u) => `${u.local_part}@${domain.domain}`);
  const { data: taken } = await admin
    .from("native_mailboxes")
    .select("email_address")
    .eq("organization_id", organizationId)
    .in("email_address", emails);
  if (taken && taken.length > 0) {
    const list = taken.map((t) => t.email_address as string).join(", ");
    return NextResponse.json(
      { error: `${list} ${taken.length === 1 ? "is" : "are"} already an inbox in LeadStart. Pick a different name.` },
      { status: 409 },
    );
  }

  // Load the Workspace admin clients (config errors are actionable 400s).
  let workspace: WorkspaceAdminClients;
  try {
    workspace = await loadWorkspaceAdminForOrg(admin, organizationId, {
      workspaceId: workspaceIdFor(domain, mode, body?.workspace_id),
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

  const now = new Date().toISOString();
  const licensing =
    body?.licensing?.product_id && body?.licensing?.sku_id
      ? { product_id: body.licensing.product_id, sku_id: body.licensing.sku_id }
      : workspace.licensingDefaults
        ? { product_id: workspace.licensingDefaults.productId, sku_id: workspace.licensingDefaults.skuId }
        : null;
  const dmarcRua = body?.dmarc_rua?.trim() || null;

  let initState;
  if (mode === "add_inboxes") {
    // The domain must already be on this Workspace: creating users on a domain
    // the tenant doesn't hold fails, and adding it here would re-run setup.
    const onWs = await domainOnWorkspace(workspace, domain.domain);
    if (!onWs.ok) {
      return NextResponse.json({ error: onWs.error }, { status: onWs.status });
    }
    initState = initAddInboxesState({
      now,
      domain: domain.domain,
      users,
      licensing,
      dmarcRua,
      previous: domain.provisioning,
      domainVerified: onWs.verified,
      // A domain still in provisioning only starts sending once DKIM lands.
      watchDkim: domain.lifecycle_status === "provisioning",
    });
  } else {
    initState = initProvisioningState({ now, domain: domain.domain, users, licensing, dmarcRua });
  }

  // Persist the new state first, CAS-guarded on the domain's current run (or its
  // absence), so two concurrent starts can't both claim the domain and the
  // runner's own CAS write has a row clock to match.
  const claim = admin
    .from("sending_domains")
    .update({ provisioning: initState, workspace_id: workspace.workspaceId })
    .eq("id", domain.id);
  const { data: claimed } = await (domain.provisioning
    ? claim.eq("provisioning->>updated_at", domain.provisioning.updated_at)
    : claim.is("provisioning", null)
  )
    .select("id")
    .maybeSingle();
  if (!claimed) {
    return NextResponse.json(
      { error: "Inbox setup was just started for this domain elsewhere. Refresh to see its progress." },
      { status: 409 },
    );
  }

  const res = await advanceProvisioning(
    { admin, registrar, workspace, gmail, checkAuth: checkDomainAuth },
    { ...domain, provisioning: initState, workspace_id: workspace.workspaceId },
  );

  // For a first setup on a manual registrar, hand back the records the owner
  // must add by hand. Adding inboxes never changes DNS.
  const manualDns =
    mode === "setup" && registrar == null
      ? [
          ...gmailTierRecords({ dmarcRua: initState.dmarc_rua ?? undefined }),
          ...(res.state.site_verification_token
            ? [{ type: "TXT" as const, name: "", content: res.state.site_verification_token }]
            : []),
        ]
      : undefined;

  return NextResponse.json({
    mode,
    provisioning: res.state,
    advanced: res.advanced,
    revealed_passwords: res.revealed_passwords,
    became_warming: res.became_warming,
    manual_dns: manualDns,
  });
}
