// GET/POST /api/admin/buyer-experience: owner/va read + write of the buyer portal
// content (the "Buyer experience" editor). Writes go through the service-role
// client; the posted blob is normalized over defaults before storing, so a partial
// or malformed edit can never corrupt what buyers render.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mergeBuyerExperience } from "@/lib/buyer-experience/content";

async function requireAdmin() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const role = user.app_metadata?.role;
  if (role !== "owner" && role !== "va") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const admin = createAdminClient();
  const { data } = await admin.from("buyer_experience_config").select("content").eq("singleton", true).maybeSingle();
  return NextResponse.json({ experience: mergeBuyerExperience((data as { content?: unknown } | null)?.content) });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  let body: { experience?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const content = mergeBuyerExperience(body.experience);
  const admin = createAdminClient();
  const { error } = await admin
    .from("buyer_experience_config")
    .update({ content, updated_at: new Date().toISOString(), updated_by: gate.user.id } as Record<string, unknown>)
    .eq("singleton", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, experience: content });
}
