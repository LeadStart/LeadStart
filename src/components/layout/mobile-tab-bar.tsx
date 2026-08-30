"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { AppRole } from "@/types/app";
import {
  Home,
  Inbox,
  Sparkles,
  Mail,
  Users,
  LayoutDashboard,
  Settings,
} from "lucide-react";

interface Tab {
  href: string;
  label: string;
  icon: React.ReactNode;
  // Home tabs match only their exact path; the rest also light up on nested
  // routes (e.g. /admin/campaigns/123 keeps "Campaigns" active).
  exact?: boolean;
}

const adminTabs: Tab[] = [
  { href: "/admin", label: "Home", icon: <Home size={22} />, exact: true },
  { href: "/admin/inbox", label: "Inbox", icon: <Inbox size={22} /> },
  { href: "/admin/prospecting", label: "Prospect", icon: <Sparkles size={22} /> },
  { href: "/admin/campaigns", label: "Campaigns", icon: <Mail size={22} /> },
  { href: "/admin/clients", label: "Clients", icon: <Users size={22} /> },
];

const clientTabs: Tab[] = [
  { href: "/client", label: "Home", icon: <LayoutDashboard size={22} />, exact: true },
  { href: "/client/inbox", label: "Inbox", icon: <Mail size={22} /> },
  { href: "/client/settings", label: "Settings", icon: <Settings size={22} /> },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * Mobile-only primary navigation. A fixed bottom tab bar (iOS/Android style)
 * that replaces the hamburger as the main way around on phones/tablets; hidden
 * at `lg` where the floating sidebar rail takes over. Secondary surfaces live
 * behind the avatar menu ("All sections") in the topbar.
 */
export function MobileTabBar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const isAdmin = role === "owner" || role === "va";
  const tabs = isAdmin ? adminTabs : clientTabs;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-white lg:hidden"
      // Clear the iPhone home indicator so the bottom row of tabs stays tappable.
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {tabs.map((tab) => {
        const active = isActive(pathname, tab.href, tab.exact);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span
              className={cn(
                "flex h-7 items-center justify-center rounded-full px-4 transition-colors",
                active ? "bg-primary/10" : "bg-transparent"
              )}
            >
              {tab.icon}
            </span>
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
