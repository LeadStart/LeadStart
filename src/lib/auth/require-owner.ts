// Shared owner-only guard for admin API routes. The same block was inlined in
// every /api/admin route; the new domains + registrar routes share this one.
// Returns { organizationId } on success, or { error } — a ready NextResponse to
// return straight from the handler.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export type OwnerAuth =
  | { error: NextResponse; organizationId?: undefined }
  | { error?: undefined; organizationId: string };

export async function requireOwner(): Promise<OwnerAuth> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return { error: NextResponse.json({ error: "No organization on user" }, { status: 400 }) };
  }
  return { organizationId };
}
