// DELETE /api/admin/domains/[id]: remove a sending domain: delete it from the
// Google Workspace tenant (Directory domains.delete) when it was added there,
// and drop the sending_domains row. Refuses if the domain still has inboxes
// (deleting would orphan live mailboxes, and Google rejects deleting a domain
// that still has users). Owner only, org-scoped.
//
// Used to re-provision a stuck / mis-set-up domain from scratch, or to clean up
// one that was never finished. Does NOT touch the domain's registration or its
// DNS records at the registrar: only the Workspace membership + our tracking.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadWorkspaceAdminForOrg } from "@/lib/google/org";
import { GoogleConfigError } from "@/lib/google/auth";
import type { SendingDomain } from "@/types/app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const maxDuration = 30;

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
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

  // Guard: never delete a domain that still has inboxes, that would orphan live
  // mailboxes (and Google rejects deleting a domain that still has users).
  const { count } = await admin
    .from("native_mailboxes")
    .select("id", { count: "exact", head: true })
    .eq("domain_id", id);
  if (count && count > 0) {
    return NextResponse.json(
      { error: `This domain has ${count} inbox${count === 1 ? "" : "es"}. Remove them before deleting the domain.` },
      { status: 409 },
    );
  }

  // Remove it from the Workspace tenant (best-effort). A missing Google config or
  // an already-gone domain (404) is fine; any other Google error we surface and
  // leave our row in place so the domain never lingers untracked in Workspace.
  let googleDeleted: boolean | null = null;
  let googleError: string | null = null;
  try {
    const workspace = await loadWorkspaceAdminForOrg(admin, organizationId, {
      workspaceId: domain.workspace_id ?? null,
    });
    const res = await workspace.directory.deleteDomain(domain.domain);
    googleDeleted = res.deleted;
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      googleDeleted = null; // Google not configured for this org: nothing there.
    } else {
      googleError = err instanceof Error ? err.message : String(err);
    }
  }
  if (googleError) {
    return NextResponse.json(
      {
        error: `Could not remove ${domain.domain} from Google Workspace: ${googleError}. The domain was left in place, if it has Google users, delete those first.`,
      },
      { status: 502 },
    );
  }

  const { error: delError } = await admin.from("sending_domains").delete().eq("id", id);
  if (delError) {
    return NextResponse.json({ error: delError.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true, domain: domain.domain, google_deleted: googleDeleted });
}
