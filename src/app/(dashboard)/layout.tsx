import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { setDemoRole } from "@/lib/supabase/demo-client";
import { DashboardShell } from "./dashboard-shell";
import type { AppRole } from "@/types/app";
import { headers } from "next/headers";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Detect path to set demo role correctly
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") || headersList.get("x-invoke-path") || "";

  // If we're on a /client path, set demo role to client
  if (pathname.startsWith("/client")) {
    setDemoRole("client");
  } else {
    setDemoRole("owner");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const role = ((user as { app_metadata?: { role?: string } }).app_metadata?.role || "client") as AppRole;

  return (
    <DashboardShell role={role} actualRole={role} userEmail={(user as { email?: string }).email || "demo@leadstart.com"}>
      {children}
    </DashboardShell>
  );
}
