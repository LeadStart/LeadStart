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

  // getUser() validates the JWT — this is the auth check.
  // The middleware already does role-based routing, so this is
  // primarily to get the user's email and role for the shell.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const role = ((user as { app_metadata?: { role?: string } }).app_metadata?.role || "client") as AppRole;

  return (
    <DashboardShell role={role} userEmail={(user as { email?: string }).email || "demo@leadstart.com"}>
      {children}
    </DashboardShell>
  );
}
