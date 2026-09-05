"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { AdminPrefetcher } from "@/components/layout/admin-prefetcher";
import { ViewAsBanner } from "@/components/layout/view-as-banner";
import type { AppRole } from "@/types/app";

export function DashboardShell({
  role,
  actualRole,
  userEmail,
  viewingAsClient = false,
  viewAsClientName = null,
  children,
}: {
  role: AppRole;
  actualRole?: AppRole;
  userEmail: string;
  /** True while an admin previews a client portal (src/lib/auth/view-as.ts). */
  viewingAsClient?: boolean;
  viewAsClientName?: string | null;
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const isAdmin = role === "owner" || role === "va";

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {isAdmin && <AdminPrefetcher />}
      <Sidebar
        role={role}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {/* Offset (desktop) clears the floating rail: see globals.css `.app-shell-content`.
          The whole column scrolls as one (overflow-y-auto here, not on <main>), so the
          topbar is NOT pinned. It sits at the top of each page and scrolls away with
          the content rather than staying fixed. */}
      <div className="app-shell-content flex flex-1 flex-col overflow-y-auto min-w-0">
        {/* Sticky (unlike the topbar) because the preview is the one state you must
            never lose track of, and this bar carries the only way out of it. */}
        {viewingAsClient && <ViewAsBanner clientName={viewAsClientName} />}
        <Topbar
          userEmail={userEmail}
          role={role}
          actualRole={actualRole || role}
          viewingAsClient={viewingAsClient}
          onMenuClick={() => setSidebarOpen(true)}
        />
        {/* `.app-main` (globals.css, desktop) zeroes the left padding so pages
            share the floating topbar's left gridline. Extra bottom padding on
            mobile clears the fixed MobileTabBar; reset at `lg` where the bar hides. */}
        <main className="app-main flex-1 p-4 sm:p-6 pb-24 lg:pb-6">
          {children}
        </main>
      </div>
      {/* Mobile primary nav: fixed bottom tab bar (hidden at lg) */}
      <MobileTabBar role={role} />
    </div>
  );
}
