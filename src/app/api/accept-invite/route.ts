import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Mark all client_users rows for this user as active
  const admin = createAdminClient();
  await admin
    .from("client_users")
    .update({ invite_status: "active" })
    .eq("user_id", user.id)
    .eq("invite_status", "pending");

  return NextResponse.json({ success: true });
}
