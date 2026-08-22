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
  Building2,
  Key,
  LayoutDashboard,
  ContactRound,
  CheckSquare,
  Inbox,
  Settings,
  Sparkles,
  X,
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
  { href: "/admin/inbox", label: "Inbox", icon: <Inbox size={18} /> },
  { href: "/admin/contacts", label: "Contacts", icon: <ContactRound size={18} /> },
  { href: "/admin/prospecting", label: "Prospecting", icon: <Sparkles size={18} /> },
  { href: "/admin/feedback", label: "Feedback", icon: <MessageSquare size={18} /> },
  { href: "/admin/reports", label: "Reports", icon: <FileText size={18} /> },
];

const adminSendingNav: NavItem[] = [
  { href: "/admin/mailboxes", label: "Mailboxes", icon: <Inbox size={18} /> },
];

const adminSettingsNav: NavItem[] = [
  { href: "/admin/tasks", label: "Tasks", icon: <CheckSquare size={18} /> },
  { href: "/admin/billing", label: "Billing", icon: <CreditCard size={18} /> },
  { href: "/admin/settings/team", label: "Team", icon: <Building2 size={18} /> },
  { href: "/admin/settings/api", label: "Integrations", icon: <Key size={18} /> },
];

const clientNav: NavItem[] = [
  { href: "/client", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/client/inbox", label: "Inbox", icon: <Mail size={18} /> },
  { href: "/client/settings", label: "Settings", icon: <Settings size={18} /> },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground font-semibold"
          : "text-sidebar-foreground hover:bg-white/10 hover:text-white"
      )}
    >
      <span className="shrink-0">{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );
}

function NavSection({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="pt-4 pb-2 px-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/50">
          {label}
        </p>
      </div>
      {items.map((item) => (
        <NavLink key={item.href} item={item} active={pathname === item.href} />
      ))}
    </>
  );
}

export function Sidebar({ role, open = false, onClose }: { role: AppRole; open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const isAdmin = role === "owner" || role === "va";
  const nav = isAdmin ? adminNav : clientNav;
  const sendingNav = isAdmin ? adminSendingNav : [];
  const settingsNav = isAdmin ? adminSettingsNav : [];

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
        style={{
          // White at the top so the (dark-artwork) logo reads clearly, fading
          // down through brand indigo into the deep-navy nav panel. Custom
          // gradients go inline — Tailwind v4 @layer utilities don't reliably
          // emit them (see CLAUDE.md).
          background:
            "linear-gradient(180deg, #ffffff 0px, #ffffff 116px, #1e249e 205px, #131b63 52%, #0f172a 100%)",
          backgroundColor: "#0f172a",
        }}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col overflow-hidden border-r border-slate-200 transition-transform duration-300 lg:static lg:translate-x-0 lg:transition-none",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Brand header — logo sits on the solid-white top of the gradient */}
        <div className="relative flex h-[124px] items-center justify-center px-6">
          <Link href={isAdmin ? "/admin" : "/client"} className="flex items-center">
            <Image src={leadstartLogo} alt="LeadStart" priority className="h-[120px] w-auto" />
          </Link>
          {/* Close button (mobile only) */}
          <button
            onClick={onClose}
            className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-black/5 lg:hidden"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation — pt clears the white→blue fade so items land on the settled panel */}
        <nav className="flex-1 space-y-0.5 px-3 pt-5 pb-4 overflow-y-auto">
          {nav.map((item) => (
            <NavLink key={item.href} item={item} active={pathname === item.href} />
          ))}
          <NavSection label="Sending" items={sendingNav} pathname={pathname} />
          <NavSection label="Settings" items={settingsNav} pathname={pathname} />
        </nav>

        {/* Footer */}
        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
              {role === "owner" ? "A" : role === "va" ? "V" : "C"}
            </div>
            <div>
              <p className="text-xs font-medium text-sidebar-foreground">
                {role === "owner" ? "Admin" : role === "va" ? "VA" : "Client"}
              </p>
              <p className="text-[10px] text-sidebar-foreground/60">LeadStart</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
