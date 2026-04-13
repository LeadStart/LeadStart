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
    return NextResponse.json({ error: "Only owners can send invites" }, { status: 403 });
  }

  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization found" }, { status: 400 });
  }

  const body = await request.json();
  const { email, role: inviteRole, client_id, full_name } = body;

  if (!email || !inviteRole) {
    return NextResponse.json({ error: "Email and role required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Use generateLink to create the user + get an invite link
  // (Supabase's built-in email isn't configured, so inviteUserByEmail fails)
  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: {
      data: {
        full_name: full_name || "",
        role: inviteRole,
        organization_id: organizationId,
        client_id: client_id || null,
      },
      redirectTo: `${request.nextUrl.origin}/auth/callback`,
    },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // The action_link contains the verification token
  // When Resend is configured, send a branded invite email here
  // For now, return the link for the admin to share
  const actionLink = data?.properties?.action_link;

  return NextResponse.json({ success: true, invite_link: actionLink });
}
