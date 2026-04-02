import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const supabase = await createClient();

  // Verify the user is an admin (owner or va)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || (profile.role !== "owner" && profile.role !== "va")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { eventId, excluded } = await req.json();

  if (!eventId || typeof excluded !== "boolean") {
    return NextResponse.json({ error: "Missing eventId or excluded boolean" }, { status: 400 });
  }

  const { error } = await supabase
    .from("webhook_events")
    .update({ excluded })
    .eq("id", eventId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
