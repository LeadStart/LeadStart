"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Coins, Workflow, Building2, Key, Tags } from "lucide-react";

// Settings hub — one tab in the sidebar, with sub-sections switched by this
// sub-tab bar. Each tab is its own route under /admin/settings so deep links
// and the browser back button work. Team + Integrations are the existing
// pages folded in; Workflows was folded out of the top-level nav; Tokens is
// the new contact-sourcing product config.
const SETTINGS_TABS = [
  { href: "/admin/settings/tokens", label: "Tokens", icon: Coins },
  { href: "/admin/settings/workflows", label: "Workflows", icon: Workflow },
  { href: "/admin/settings/team", label: "Team", icon: Building2 },
  { href: "/admin/settings/api", label: "Integrations", icon: Key },
  { href: "/admin/settings/tags", label: "Tags", icon: Tags },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      {/* Sub-tab bar — flat underline tabs. Active tab carries the brand
          underline; the row scrolls horizontally on narrow screens. */}
      <div className="overflow-x-auto border-b border-border/60">
        <nav className="-mb-px flex min-w-max gap-1">
          {SETTINGS_TABS.map((tab) => {
            const active =
              pathname === tab.href || pathname.startsWith(tab.href + "/");
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "border-[#2E37FE] text-[#2E37FE]"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                )}
              >
                <Icon size={16} />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {children}
    </div>
  );
}
