import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { DashboardShell } from "./dashboard-shell";
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

  const role = (h.get("x-user-role") as AppRole | null) ?? "client";
  const userEmail = h.get("x-user-email") ?? "demo@leadstart.com";

  return (
    <DashboardShell role={role} actualRole={role} userEmail={userEmail}>
      {children}
    </DashboardShell>
  );
}
