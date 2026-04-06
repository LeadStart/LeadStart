import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: NextRequest) {
  // Verify caller is an owner
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = user.app_metadata?.role;
  if (role !== "owner") {
    return NextResponse.json({ error: "Only owners can reset passwords" }, { status: 403 });
  }

  const body = await request.json();
  const { email } = body;

  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  // Use the admin client to send password reset email
  const admin = createAdminClient();
  const { error } = await admin.auth.resetPasswordForEmail(email, {
    redirectTo: `${request.nextUrl.origin}/auth/callback?next=/update-password`,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
