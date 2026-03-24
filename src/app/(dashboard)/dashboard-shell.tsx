"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import type { AppRole } from "@/types/app";

export function DashboardShell({
  role: initialRole,
  userEmail,
  children,
}: {
  role: AppRole;
  userEmail: string;
  children: React.ReactNode;
}) {
  const [role, setRole] = useState<AppRole>(initialRole);
  const router = useRouter();
  const pathname = usePathname();

  function handleRoleSwitch(newRole: AppRole) {
    setRole(newRole);
    // Navigate to the correct dashboard
    if (newRole === "client") {
      router.push("/client");
    } else {
      router.push("/admin");
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar role={role} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar
          userEmail={userEmail}
          role={role}
          onRoleSwitch={handleRoleSwitch}
        />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
