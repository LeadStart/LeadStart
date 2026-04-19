import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function verifyOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  if (user.app_metadata?.role !== "owner") return null;
  return user;
}

// PATCH — update team member (name, role)
export async function PATCH(request: NextRequest) {
  const user = await verifyOwner();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { user_id, full_name, role, receives_contact_notifications } = await request.json();
  if (!user_id) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  if (role && !["owner", "va"].includes(role)) {
    return NextResponse.json({ error: "Role must be owner or va" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Update profile
  const updates: Record<string, unknown> = {};
  if (full_name !== undefined) updates.full_name = full_name;
  if (role !== undefined) updates.role = role;
  if (receives_contact_notifications !== undefined) {
    updates.receives_contact_notifications = !!receives_contact_notifications;
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await admin.from("profiles").update(updates).eq("id", user_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // If role changed, also update auth user app_metadata
  if (role) {
    const { error: authError } = await admin.auth.admin.updateUserById(user_id, {
      app_metadata: { role },
    });
    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

// PUT — toggle active status
export async function PUT(request: NextRequest) {
  const user = await verifyOwner();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { user_id, is_active } = await request.json();
  if (!user_id || is_active === undefined) {
    return NextResponse.json({ error: "user_id and is_active required" }, { status: 400 });
  }

  // Prevent deactivating yourself
  if (user_id === user.id && !is_active) {
    return NextResponse.json({ error: "Cannot deactivate yourself" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Update profile
  const { error } = await admin.from("profiles").update({ is_active }).eq("id", user_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Ban/unban at auth level
  const { error: authError } = await admin.auth.admin.updateUserById(user_id, {
    ban_duration: is_active ? "none" : "876000h", // ~100 years = effectively permanent
  });
  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

// DELETE — remove team member
export async function DELETE(request: NextRequest) {
  const user = await verifyOwner();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { user_id } = await request.json();
  if (!user_id) {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  // Prevent removing yourself
  if (user_id === user.id) {
    return NextResponse.json({ error: "Cannot remove yourself" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Delete from profiles (cascade will handle related data)
  const { error } = await admin.from("profiles").delete().eq("id", user_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Delete auth user
  const { error: authError } = await admin.auth.admin.deleteUser(user_id);
  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
