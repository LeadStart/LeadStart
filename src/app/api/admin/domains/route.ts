// POST /api/admin/domains — track an existing (already-owned) domain as a
// Gmail-tier sending domain in 'provisioning', registrar 'manual'. Lets a domain
// the owner already controls go through the whole Workspace provisioning flow
// (verify, users, mailboxes, DKIM) with zero registrar spend — and it's the
// zero-cost end-to-end test path. Owner only, org-scoped.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import type { SendingDomain } from "@/types/app";

interface CreateBody {
  domain?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const body = (await req.json().catch(() => null)) as CreateBody | null;
  const domain = (body?.domain ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return NextResponse.json({ error: "A valid bare domain is required (e.g. mail.acme.com)." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("sending_domains")
    .insert({
      organization_id: organizationId,
      domain,
      tier: "gmail",
      lifecycle_status: "provisioning",
      registrar: "manual",
      registered_at: new Date().toISOString().slice(0, 10),
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "That domain is already tracked." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ domain: data as SendingDomain });
}
