"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { AppRole } from "@/types/app";
import {
  BarChart3,
  Users,
  Mail,
  MessageSquare,
  FileText,
  CreditCard,
  Bell,
  Building2,
  Key,
  LayoutDashboard,
  Activity,
  Target,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const adminNav: NavItem[] = [
  { href: "/admin", label: "Overview", icon: <BarChart3 size={18} /> },
  { href: "/admin/clients", label: "Clients", icon: <Users size={18} /> },
  { href: "/admin/campaigns", label: "Campaigns", icon: <Mail size={18} /> },
  { href: "/admin/feedback", label: "Feedback", icon: <MessageSquare size={18} /> },
  { href: "/admin/reports", label: "Reports", icon: <FileText size={18} /> },
  { href: "/admin/prospects", label: "Prospects", icon: <Target size={18} /> },
  { href: "/admin/billing", label: "Billing", icon: <CreditCard size={18} /> },
  { href: "/admin/webhooks", label: "Events", icon: <Bell size={18} /> },
];

const adminSettingsNav: NavItem[] = [
  { href: "/admin/settings/team", label: "Team", icon: <Building2 size={18} /> },
  { href: "/admin/settings/api", label: "Integrations", icon: <Key size={18} /> },
];

const clientNav: NavItem[] = [
  { href: "/client", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/client/activity", label: "Activity", icon: <Activity size={18} /> },
  { href: "/client/reports", label: "Reports", icon: <FileText size={18} /> },
  { href: "/client/feedback", label: "My Feedback", icon: <MessageSquare size={18} /> },
];

export function Sidebar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const isAdmin = role === "owner" || role === "va";
  const nav = isAdmin ? adminNav : clientNav;
  const settingsNav = isAdmin ? adminSettingsNav : [];

  return (
    <aside className="flex h-full w-64 flex-col" style={{ background: 'linear-gradient(180deg, #1e1b4b 0%, #312e81 50%, #3730a3 100%)' }}>
      {/* Brand header */}
      <div className="flex h-16 items-center gap-3 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/15 backdrop-blur-sm">
          <Mail size={16} className="text-white" />
        </div>
        <Link href={isAdmin ? "/admin" : "/client"} className="text-lg font-bold text-white tracking-tight">
          LeadStart
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {nav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-white/15 text-white shadow-sm backdrop-blur-sm"
                  : "text-indigo-200 hover:bg-white/10 hover:text-white"
              )}
            >
              <span className={cn(isActive ? "text-white" : "text-indigo-300")}>
                {item.icon}
              </span>
              {item.label}
              {isActive && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-white" />
              )}
            </Link>
          );
        })}

        {settingsNav.length > 0 && (
          <>
            <div className="pt-6 pb-2 px-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-indigo-400">
                Settings
              </p>
            </div>
            {settingsNav.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                    isActive
                      ? "bg-white/15 text-white shadow-sm backdrop-blur-sm"
                      : "text-indigo-200 hover:bg-white/10 hover:text-white"
                  )}
                >
                  <span className={cn(isActive ? "text-white" : "text-indigo-300")}>
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 p-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-xs font-bold text-white">
            {role === "owner" ? "A" : role === "va" ? "V" : "C"}
          </div>
          <div>
            <p className="text-xs font-medium text-white">
              {role === "owner" ? "Admin" : role === "va" ? "VA" : "Client"}
            </p>
            <p className="text-[10px] text-indigo-300">LeadStart Agency</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
