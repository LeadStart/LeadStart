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
  Target,
  ContactRound,
  CheckSquare,
  Inbox,
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
  { href: "/admin/contacts", label: "Contacts", icon: <ContactRound size={18} /> },
  { href: "/admin/feedback", label: "Feedback", icon: <MessageSquare size={18} /> },
  { href: "/admin/reports", label: "Reports", icon: <FileText size={18} /> },
  { href: "/admin/prospects", label: "Prospects", icon: <Target size={18} /> },
  { href: "/admin/inbox-health", label: "Inbox Health", icon: <Inbox size={18} /> },
  { href: "/admin/billing", label: "Billing", icon: <CreditCard size={18} /> },
  { href: "/admin/webhooks", label: "Events", icon: <Bell size={18} /> },
];

const adminSettingsNav: NavItem[] = [
  { href: "/admin/tasks", label: "Tasks", icon: <CheckSquare size={18} /> },
  { href: "/admin/settings/team", label: "Team", icon: <Building2 size={18} /> },
  { href: "/admin/settings/api", label: "Integrations", icon: <Key size={18} /> },
];

const clientNav: NavItem[] = [
  { href: "/client", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/client/replies", label: "Replies", icon: <Inbox size={18} /> },
];

export function Sidebar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const isAdmin = role === "owner" || role === "va";
  const nav = isAdmin ? adminNav : clientNav;
  const settingsNav = isAdmin ? adminSettingsNav : [];

  return (
    <aside className="relative flex h-full w-64 flex-col overflow-visible border-r border-[#e2e8f0]" style={{ background: 'linear-gradient(180deg, #ffffff 0%, #6B72FF 100%)', boxShadow: '3px 0 12px rgba(15,23,42,0.06), 1px 0 3px rgba(15,23,42,0.03)' }}>
      {/* Sidebar shadow cast into content area */}
      <div className="absolute top-0 bottom-0 w-8 pointer-events-none z-0" style={{ right: '-32px', background: 'linear-gradient(90deg, rgba(15,23,42,0.12) 0%, rgba(28,36,184,0.03) 60%, transparent 100%)' }} />

      {/* Brand header */}
      <div className="flex h-16 items-center gap-3 px-6 border-b border-[#e2e8f0]">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: '#2E37FE' }}>
          <Mail size={16} className="text-white" />
        </div>
        <Link href={isAdmin ? "/admin" : "/client"} className="text-lg font-bold text-[#0f172a] tracking-tight">
          LeadStart
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4 overflow-visible" style={{ direction: 'rtl' }}>
        <div style={{ direction: 'ltr' }}>
        {nav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200 ml-2",
                isActive
                  ? "nav-notch-active text-white font-semibold"
                  : "nav-notch-hover text-[#0f172a]"
              )}
            >
              <span className={cn("relative z-[1]", isActive ? "text-white" : "text-[#64748b]")}>
                {item.icon}
              </span>
              <span className="relative z-[1]">{item.label}</span>
            </Link>
          );
        })}

        {settingsNav.length > 0 && (
          <>
            <div className="pt-6 pb-2 px-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[#64748b]">
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
                    "relative flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200 ml-2",
                    isActive
                      ? "nav-notch-active text-white font-semibold"
                      : "nav-notch-hover text-[#0f172a]"
                  )}
                >
                  <span className={cn("relative z-[1]", isActive ? "text-white" : "text-[#64748b]")}>
                    {item.icon}
                  </span>
                  <span className="relative z-[1]">{item.label}</span>
                </Link>
              );
            })}
          </>
        )}
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-white/25 p-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: '#2E37FE' }}>
            {role === "owner" ? "A" : role === "va" ? "V" : "C"}
          </div>
          <div>
            <p className="text-xs font-medium text-[#0f172a]">
              {role === "owner" ? "Admin" : role === "va" ? "VA" : "Client"}
            </p>
            <p className="text-[10px] text-[#64748b]">LeadStart Agency</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
