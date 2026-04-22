"use client";

import Link from "next/link";
import Image from "next/image";
import leadstartLogo from "../../../public/leadstart-logo.png";
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
  Phone,
  Settings,
  Unlink,
  Activity,
  X,
} from "lucide-react";
import { useOrphanCampaignCount } from "@/hooks/use-orphan-campaign-count";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const adminNav: NavItem[] = [
  { href: "/admin", label: "Overview", icon: <BarChart3 size={18} /> },
  { href: "/admin/clients", label: "Clients", icon: <Users size={18} /> },
  { href: "/admin/campaigns", label: "Campaigns", icon: <Mail size={18} /> },
  { href: "/admin/campaigns/unlinked", label: "Unlinked", icon: <Unlink size={18} /> },
  { href: "/admin/contacts", label: "Contacts", icon: <ContactRound size={18} /> },
  { href: "/admin/inbox", label: "Inbox", icon: <Phone size={18} /> },
  { href: "/admin/feedback", label: "Feedback", icon: <MessageSquare size={18} /> },
  { href: "/admin/reports", label: "Reports", icon: <FileText size={18} /> },
  { href: "/admin/prospects", label: "Prospects", icon: <Target size={18} /> },
  { href: "/admin/inbox-health", label: "Inbox Health", icon: <Inbox size={18} /> },
  { href: "/admin/billing", label: "Billing", icon: <CreditCard size={18} /> },
  { href: "/admin/webhooks", label: "Events", icon: <Bell size={18} /> },
  { href: "/admin/pipeline-health", label: "Pipeline Health", icon: <Activity size={18} /> },
];

const adminSettingsNav: NavItem[] = [
  { href: "/admin/tasks", label: "Tasks", icon: <CheckSquare size={18} /> },
  { href: "/admin/settings/team", label: "Team", icon: <Building2 size={18} /> },
  { href: "/admin/settings/api", label: "Integrations", icon: <Key size={18} /> },
];

const clientNav: NavItem[] = [
  { href: "/client", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/client/inbox", label: "Inbox", icon: <Mail size={18} /> },
  { href: "/client/settings", label: "Settings", icon: <Settings size={18} /> },
];

export function Sidebar({ role, open = false, onClose }: { role: AppRole; open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const isAdmin = role === "owner" || role === "va";
  const nav = isAdmin ? adminNav : clientNav;
  const settingsNav = isAdmin ? adminSettingsNav : [];
  const orphanCount = useOrphanCampaignCount(role);

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col overflow-hidden border-r border-[#e2e8f0] transition-transform duration-300 lg:static lg:translate-x-0 lg:transition-none lg:overflow-visible",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
        style={{ background: 'linear-gradient(180deg, #ffffff 0%, #6B72FF 100%)', boxShadow: '3px 0 12px rgba(15,23,42,0.06), 1px 0 3px rgba(15,23,42,0.03)' }}
      >
      {/* Sidebar shadow cast into content area (desktop only) */}
      <div className="absolute top-0 bottom-0 w-8 pointer-events-none z-0 hidden lg:block" style={{ right: '-32px', background: 'linear-gradient(90deg, rgba(15,23,42,0.12) 0%, rgba(28,36,184,0.03) 60%, transparent 100%)' }} />

      {/* Brand header */}
      <div className="relative flex h-24 items-center justify-center px-6 border-b border-[#e2e8f0]">
        <Link href={isAdmin ? "/admin" : "/client"} className="flex items-center">
          <Image src={leadstartLogo} alt="LeadStart" priority className="h-20 w-auto" />
        </Link>
        {/* Close button (mobile only) */}
        <button
          onClick={onClose}
          className="absolute right-4 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-lg text-[#0f172a] hover:bg-black/5 lg:hidden"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4 overflow-visible" style={{ direction: 'rtl' }}>
        <div style={{ direction: 'ltr' }}>
        {nav.map((item) => {
          const isActive = pathname === item.href;
          const showOrphanBadge =
            item.href === "/admin/campaigns/unlinked" && orphanCount > 0;
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
              <span className={cn("relative z-[1]", isActive ? "text-white" : "text-[#0f172a]")}>
                {item.icon}
              </span>
              <span className="relative z-[1]">{item.label}</span>
              {showOrphanBadge && (
                <span
                  className="relative z-[1] ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold bg-amber-500 text-white"
                  aria-label={`${orphanCount} unlinked campaigns`}
                >
                  {orphanCount}
                </span>
              )}
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
                  <span className={cn("relative z-[1]", isActive ? "text-white" : "text-[#0f172a]")}>
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
            <p className="text-[10px] text-black">LeadStart Agency</p>
          </div>
        </div>
      </div>
      </aside>
    </>
  );
}
