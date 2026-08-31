"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import { AdminPrefetcher } from "@/components/layout/admin-prefetcher";
import type { AppRole } from "@/types/app";
import { roleHomePath } from "@/lib/auth/roles";

export function DashboardShell({
  role: initialRole,
  actualRole,
  userEmail,
  children,
}: {
  role: AppRole;
  actualRole?: AppRole;
  userEmail: string;
  children: React.ReactNode;
}) {
  const [role, setRole] = useState<AppRole>(initialRole);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  function handleRoleSwitch(newRole: AppRole) {
    setRole(newRole);
    router.push(roleHomePath(newRole));
  }

  const isAdmin = role === "owner" || role === "va";

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {isAdmin && <AdminPrefetcher />}
      <Sidebar role={role} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      {/* Offset (desktop) clears the floating rail — see globals.css `.app-shell-content`.
          The whole column scrolls as one (overflow-y-auto here, not on <main>), so the
          topbar is NOT pinned — it sits at the top of each page and scrolls away with
          the content rather than staying fixed. */}
      <div className="app-shell-content flex flex-1 flex-col overflow-y-auto min-w-0">
        <Topbar
          userEmail={userEmail}
          role={role}
          actualRole={actualRole || initialRole}
          onRoleSwitch={handleRoleSwitch}
          onMenuClick={() => setSidebarOpen(true)}
        />
        {/* `.app-main` (globals.css, desktop) zeroes the left padding so pages
            share the floating topbar's left gridline. Extra bottom padding on
            mobile clears the fixed MobileTabBar; reset at `lg` where the bar hides. */}
        <main className="app-main flex-1 p-4 sm:p-6 pb-24 lg:pb-6">
          {children}
        </main>
      </div>
      {/* Mobile primary nav — fixed bottom tab bar (hidden at lg) */}
      <MobileTabBar role={role} />
    </div>
  );
}
