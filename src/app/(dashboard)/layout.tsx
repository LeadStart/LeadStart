import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "./dashboard-shell";
import type { AppRole } from "@/types/app";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // Use getSession() instead of getUser() — reads from cookie locally
  // without a network round-trip. The middleware already validated
  // the user with getUser(), so we just need the session data here.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    redirect("/login");
  }

  const user = session.user;
  const role = ((user as { app_metadata?: { role?: string } }).app_metadata?.role || "client") as AppRole;

  return (
    <DashboardShell role={role} userEmail={(user as { email?: string }).email || "demo@leadstart.com"}>
      {children}
    </DashboardShell>
  );
}
