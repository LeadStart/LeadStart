// GET  /api/admin/ms-oauth/settings — { has_client_id, has_secret } (never the
//                                      values themselves).
// POST /api/admin/ms-oauth/settings — save the Entra app's client id / secret
//                                      (migration 00085). Owner only.
//
// Mirrors the registrar-settings route: the client secret is sensitive, so it
// is written from a server route and NEVER read back into the browser (only
// the has_* booleans are). A blank field on save leaves the stored value as-is.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return { error: NextResponse.json({ error: "No organization on user" }, { status: 400 }) };
  }
  return { organizationId };
}

export async function GET() {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("ms_oauth_client_id, ms_oauth_client_secret")
    .eq("id", auth.organizationId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const org = data as { ms_oauth_client_id: string | null; ms_oauth_client_secret: string | null } | null;
  return NextResponse.json({
    has_client_id: !!org?.ms_oauth_client_id,
    has_secret: !!org?.ms_oauth_client_secret,
  });
}

interface PostBody {
  ms_oauth_client_id?: string;
  ms_oauth_client_secret?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, string | null> = {};
  if (typeof body.ms_oauth_client_id === "string" && body.ms_oauth_client_id.trim()) {
    update.ms_oauth_client_id = body.ms_oauth_client_id.trim();
  }
  if (typeof body.ms_oauth_client_secret === "string" && body.ms_oauth_client_secret.trim()) {
    update.ms_oauth_client_secret = body.ms_oauth_client_secret.trim();
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("organizations").update(update).eq("id", auth.organizationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data } = await admin
    .from("organizations")
    .select("ms_oauth_client_id, ms_oauth_client_secret")
    .eq("id", auth.organizationId)
    .maybeSingle();
  const org = data as { ms_oauth_client_id: string | null; ms_oauth_client_secret: string | null } | null;
  return NextResponse.json({
    has_client_id: !!org?.ms_oauth_client_id,
    has_secret: !!org?.ms_oauth_client_secret,
  });
}
