"use client";

import Link from "next/link";
import Image from "next/image";
import leadstartMark from "../../../public/leadstart-mark-transparent.png";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { AppRole } from "@/types/app";
import { roleHomePath } from "@/lib/auth/roles";
import {
  BarChart3,
  Users,
  Mail,
  MessageSquare,
  FileText,
  LayoutDashboard,
  ContactRound,
  ListChecks,
  Inbox,
  Settings,
  Sparkles,
  X,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  // When true, the item stays active on its sub-routes too (e.g. /admin/settings
  // highlighted on /admin/settings/tokens). Default: exact-path match.
  matchPrefix?: boolean;
}

const adminNav: NavItem[] = [
  { href: "/admin", label: "Overview", icon: <BarChart3 size={18} /> },
  { href: "/admin/clients", label: "Clients", icon: <Users size={18} /> },
  { href: "/admin/campaigns", label: "Campaigns", icon: <Mail size={18} /> },
  { href: "/admin/inbox", label: "Inbox", icon: <Inbox size={18} /> },
  { href: "/admin/contacts", label: "Contacts", icon: <ContactRound size={18} /> },
  { href: "/admin/linkedin-tasks", label: "LinkedIn to-dos", icon: <ListChecks size={18} /> },
  { href: "/admin/prospecting", label: "Prospecting", icon: <Sparkles size={18} /> },
  { href: "/admin/feedback", label: "Feedback", icon: <MessageSquare size={18} /> },
  { href: "/admin/reports", label: "Reports", icon: <FileText size={18} /> },
];

const adminSendingNav: NavItem[] = [
  { href: "/admin/mailboxes", label: "Mailboxes", icon: <Inbox size={18} /> },
];

// Settings is a single entry pinned to the sidebar footer (see below). Team,
// Integrations, Workflows, Tokens, Billing, and Tasks are all cards on the
// Settings hub, so there is exactly one reference to Settings.

const clientNav: NavItem[] = [
  { href: "/client", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/client/inbox", label: "Inbox", icon: <Mail size={18} /> },
];

// Self-serve buyer portal. Only the dashboard exists in Phase 1; token wallet
// (Phase 2) and sourcing (Phase 3) nav entries land as those pages are built.
const buyerNav: NavItem[] = [
  { href: "/buyer", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/buyer/search", label: "Run a search", icon: <Sparkles size={18} /> },
  { href: "/buyer/contacts", label: "My contacts", icon: <Users size={18} /> },
];

function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.matchPrefix) {
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }
  return pathname === item.href;
}

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
        <NavLink key={item.href} item={item} active={isNavActive(item, pathname)} />
      ))}
    </>
  );
}

export function Sidebar({ role, open = false, onClose }: { role: AppRole; open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const isAdmin = role === "owner" || role === "va";
  const isBuyer = role === "buyer";
  const nav = isAdmin ? adminNav : isBuyer ? buyerNav : clientNav;
  const sendingNav = isAdmin ? adminSendingNav : [];

  // Settings is pinned to the very bottom as a single entry, replacing the old
  // profile block: the top-right avatar menu already covers the profile. Admin
  // deep-links to the Settings hub (Tasks + Billing are sub-tabs inside it);
  // clients to their own settings. The buyer portal has no settings surface yet.
  const settingsItem: NavItem | null = isAdmin
    ? { href: "/admin/settings", label: "Settings", icon: <Settings size={18} />, matchPrefix: true }
    : isBuyer
      ? null
      : { href: "/client/settings", label: "Settings", icon: <Settings size={18} />, matchPrefix: true };

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
          // Solid brand-blue → navy. The floating rail carries a real
          // elevation shadow (globals.css `.app-rail`) and the logo a soft
          // bloom: deliberate exceptions to the flat contract, approved
          // 2026-08-23 (see UI_RULES.md). Gradient stays inline (Tailwind v4
          // @layer utilities don't reliably emit it).
          background:
            "linear-gradient(180deg, #1b2273 0%, #151d67 34%, #0f172a 100%)",
          backgroundColor: "#0f172a",
        }}
        className={cn(
          // Mobile: full-height slide-in drawer. Desktop (lg): `.app-rail`
          // (globals.css) makes it a floating, inset, rounded, elevated card.
          "app-rail fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-hidden transition-transform duration-300 lg:translate-x-0 lg:transition-none",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Brand header: transparent mark backlit by a soft bloom + live wordmark */}
        <div className="relative flex flex-col items-center gap-2.5 px-4 pt-4 pb-3">
          <Link href={roleHomePath(role)} className="flex flex-col items-center gap-2.5">
            <span className="relative flex items-center justify-center">
              {/* Spotlight bloom (mockup direction D @ 0.91): a wide soft aura +
                  a crisp bright core behind the transparent mark, so the full
                  funnel reads on white. Two stacked radials, each scaled 0.91;
                  both fade to 0 above the wordmark so it stays on navy. */}
              <span
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2"
                style={{
                  width: 216,
                  height: 128,
                  transform: "translate(-50%, -52%) scale(0.91)",
                  background:
                    "radial-gradient(ellipse at 50% 46%, rgba(255,255,255,0.44) 0%, rgba(255,255,255,0.15) 44%, rgba(255,255,255,0) 78%)",
                  filter: "blur(14px)",
                }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2"
                style={{
                  width: 128,
                  height: 92,
                  transform: "translate(-50%, -52%) scale(0.91)",
                  background:
                    "radial-gradient(ellipse at 50% 46%, #ffffff 0%, rgba(255,255,255,0.90) 40%, rgba(255,255,255,0.28) 70%, rgba(255,255,255,0) 84%)",
                  filter: "blur(4px)",
                }}
              />
              <Image src={leadstartMark} alt="LeadStart" priority className="relative h-[62px] w-auto" />
            </span>
            <span
              className="relative text-[17px] font-extrabold uppercase tracking-[0.2em] leading-none"
              style={{
                backgroundImage: "linear-gradient(180deg, #ffffff 0%, #c3ccff 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              LeadStart
            </span>
          </Link>
          {/* Close button (mobile only) */}
          <button
            onClick={onClose}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 lg:hidden"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 px-3 pt-3 pb-4 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {nav.map((item) => (
            <NavLink key={item.href} item={item} active={isNavActive(item, pathname)} />
          ))}
          <NavSection label="Sending" items={sendingNav} pathname={pathname} />
        </nav>

        {/* Footer: a single Settings entry pinned to the bottom. Replaces the
            old profile block; the top-right avatar menu already shows profile. */}
        {settingsItem && (
          <div className="border-t border-sidebar-border p-3">
            <NavLink item={settingsItem} active={isNavActive(settingsItem, pathname)} />
          </div>
        )}
      </aside>
    </>
  );
}
