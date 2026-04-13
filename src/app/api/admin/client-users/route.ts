import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Only owners can manage client users" }, { status: 403 });
  }

  const { client_id, user_id } = await request.json();
  if (!client_id || !user_id) {
    return NextResponse.json({ error: "client_id and user_id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("client_users")
    .delete()
    .eq("client_id", client_id)
    .eq("user_id", user_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
