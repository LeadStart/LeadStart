import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  const { token, email, password, full_name } = await request.json();

  if (!token || !email || !password) {
    return NextResponse.json({ error: "Token, email, and password required" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find the client_users row by invite_token
  const { data: cuRow, error: cuError } = await admin
    .from("client_users")
    .select("user_id, client_id, invite_status")
    .eq("invite_token", token)
    .single();

  if (cuError || !cuRow) {
    return NextResponse.json({ error: "Invalid or expired invite link" }, { status: 400 });
  }

  if (cuRow.invite_status === "active") {
    return NextResponse.json({ error: "This invite has already been accepted" }, { status: 400 });
  }

  // Set the user's password and name via admin API
  const { error: updateError } = await admin.auth.admin.updateUserById(cuRow.user_id, {
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name || "" },
  });

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Update profile name
  if (full_name) {
    await admin.from("profiles").update({ full_name }).eq("id", cuRow.user_id);
  }

  // Mark invite as accepted and clear token
  await admin
    .from("client_users")
    .update({ invite_status: "active", invite_token: null })
    .eq("user_id", cuRow.user_id)
    .eq("client_id", cuRow.client_id);

  return NextResponse.json({ success: true });
}
