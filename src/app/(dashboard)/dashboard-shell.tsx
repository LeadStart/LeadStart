"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { AdminPrefetcher } from "@/components/layout/admin-prefetcher";
import type { AppRole } from "@/types/app";

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
    if (newRole === "client") {
      router.push("/client");
    } else {
      router.push("/admin");
    }
  }

  const isAdmin = role === "owner" || role === "va";

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {isAdmin && <AdminPrefetcher />}
      <Sidebar role={role} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Topbar
          userEmail={userEmail}
          role={role}
          actualRole={actualRole || initialRole}
          onRoleSwitch={handleRoleSwitch}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
