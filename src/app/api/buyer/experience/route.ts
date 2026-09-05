// GET /api/buyer/experience: the buyer portal's live content (the admin-edited
// copy/presentation), merged over code defaults. Service-role read scoped to a
// buyer session; the content is global (same for every buyer), never per-buyer.

import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { mergeBuyerExperience } from "@/lib/buyer-experience/content";

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const { data } = await admin.from("buyer_experience_config").select("content").eq("singleton", true).maybeSingle();
  return NextResponse.json({ experience: mergeBuyerExperience((data as { content?: unknown } | null)?.content) });
}
