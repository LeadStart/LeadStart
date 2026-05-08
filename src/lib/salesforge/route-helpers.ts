// Shared helpers for the /api/admin/salesforge/* routes. Most routes
// need the same three things:
//   1. Verify the caller is an authenticated owner
//   2. Resolve the org's salesforge_api_key + salesforge_workspace_id
//   3. Construct a SalesforgeClient
// This module collapses those steps into one call.

import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "./client";

export interface ResolvedSalesforgeContext {
  organizationId: string;
  workspaceId: string;
  client: SalesforgeClient;
  // Convenience pass-through if a route ever needs it.
  apiKey: string;
}

export type ResolveResult =
  | { ok: true; ctx: ResolvedSalesforgeContext }
  | { ok: false; response: NextResponse };

/**
 * Centralised auth + creds resolution for owner-only Salesforge routes.
 *
 * Call at the top of any /api/admin/salesforge/* route handler:
 *
 *   const r = await resolveSalesforgeOwnerContext();
 *   if (!r.ok) return r.response;
 *   const { client, workspaceId } = r.ctx;
 *
 * Returns a 401/403/400 NextResponse if any precondition fails — the
 * caller doesn't have to repeat the auth boilerplate.
 */
export async function resolveSalesforgeOwnerContext(): Promise<ResolveResult> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (user.app_metadata?.role !== "owner") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Owner role required" }, { status: 403 }),
    };
  }
  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No organization on user" }, { status: 400 }),
    };
  }

  const admin = createAdminClient();
  const { data: orgData } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", organizationId)
    .maybeSingle();
  const org = orgData as
    | { salesforge_api_key: string | null; salesforge_workspace_id: string | null }
    | null;
  if (!org?.salesforge_api_key) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Salesforge API key not set on organization." },
        { status: 400 },
      ),
    };
  }
  if (!org.salesforge_workspace_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Salesforge workspace not selected on organization." },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      organizationId,
      workspaceId: org.salesforge_workspace_id,
      client: new SalesforgeClient(org.salesforge_api_key),
      apiKey: org.salesforge_api_key,
    },
  };
}

/**
 * Wrap a Salesforge SDK call with consistent error response shaping.
 * Returns the SDK's response on success, or a 502 NextResponse on
 * failure (the caller can early-return that).
 */
export async function callSalesforge<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${label} failed: ${message}` },
        { status: 502 },
      ),
    };
  }
}
