import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DashboardShell } from "./dashboard-shell";
import { createClient } from "@/lib/supabase/server";
import { isAdminRole } from "@/lib/auth/roles";
import { VIEW_AS_HEADER } from "@/lib/auth/view-as";
import type { AppRole } from "@/types/app";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware resolved the user and forwarded identity via request headers,
  // so we don't need to spin up a Supabase SSR client here again.
  const h = await headers();
  const userId = h.get("x-user-id");
  if (!userId) {
    redirect("/login");
  }

  const actualRole = (h.get("x-user-role") as AppRole | null) ?? "client";
  const userEmail = h.get("x-user-email") ?? "demo@leadstart.com";

  // "View as client" preview (src/lib/auth/view-as.ts). The middleware only
  // forwards this header for an owner/VA, but we re-check the role here so the
  // portal shell can never be flipped by a header alone.
  const viewAsClientId = isAdminRole(actualRole) ? h.get(VIEW_AS_HEADER) : null;

  let viewAsClientName: string | null = null;
  if (viewAsClientId) {
    // One extra round-trip, and only while a preview is running. Reads under
    // the admin's own RLS ("Admin/VA can view all clients in org"), so a
    // client_id outside their org resolves to null and the banner says so.
    const supabase = await createClient();
    const { data } = await supabase
      .from("clients")
      .select("name")
      .eq("id", viewAsClientId)
      .maybeSingle();
    viewAsClientName = (data?.name as string | undefined) ?? null;
  }

  // While previewing we report the role as "client" for BOTH props on purpose.
  // `role` drives the nav (sidebar + mobile tabs) and `actualRole` gates the
  // admin-only topbar chrome (global search, notification bell). Leaving the
  // latter as "owner" would leave admin furniture on screen and defeat the
  // whole point, which is seeing exactly what the client sees. The banner is
  // what tells you you're in a preview, and it carries the way out.
  const displayRole: AppRole = viewAsClientId ? "client" : actualRole;

  return (
    <DashboardShell
      role={displayRole}
      actualRole={displayRole}
      userEmail={userEmail}
      viewAsClientName={viewAsClientId ? viewAsClientName : null}
      viewingAsClient={!!viewAsClientId}
    >
      {children}
    </DashboardShell>
  );
}
