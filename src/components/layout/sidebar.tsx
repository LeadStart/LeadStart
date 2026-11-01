"use client";

import Link from "next/link";
import Image from "next/image";
import leadstartMark from "../../../public/leadstart-mark-transparent.png";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { pullToClose } from "@/lib/ui/sheet-pull";
import type { AppRole } from "@/types/app";
import { roleHomePath } from "@/lib/auth/roles";
import {
  BarChart3,
  Calculator,
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
  { href: "/admin/planner", label: "Planner", icon: <Calculator size={18} /> },
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

// Forge's rail rows (task #228): a quiet hover, and the chosen row as Forge's
// chosen row in LeadStart's colours: the brand fill with its 140deg sheen and a
// soft drop under it (Forge's `.rail-row.on .rail-item` before its Sterling theme).
function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex justify-start items-center gap-3 rounded-xl px-3 py-[9px] text-[13.5px] font-medium transition-[background-color,box-shadow,color] duration-150",
        active
          ? "bg-primary bg-(image:--tex-brand) text-white shadow-[0_1px_1px_rgba(0,0,0,0.2),0_4px_12px_rgba(5,8,40,0.4)]"
          : "text-[#dbe3f0]/85 hover:bg-white/7 hover:text-white"
      )}
    >
      <span className={cn("shrink-0", active ? "text-white" : "text-[#8b95b5]")}>{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );
}

function NavSection({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="px-3 pt-4 pb-1.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#8b95b5]">
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
  const aside = useRef<HTMLElement>(null);
  const dim = useRef<HTMLDivElement>(null);

  // Every way out (the popups rule): Esc closes the drawer while it's open.
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // On a phone the drawer pulls shut to the left from anywhere on it (lib/ui/sheet-pull.ts):
  // it follows the finger as its dim fades, closes past a third of its width or on a
  // flick, and springs back otherwise. Let go, the drawer's own transition (globals.css
  // `.app-rail`) takes it on from where the finger left it, so it never jumps.
  useEffect(() => {
    const el = aside.current;
    if (!el || !onClose) return;
    const phone = window.matchMedia("(max-width: 1023.98px)");
    let off: (() => void) | null = null;
    const wire = () => {
      off?.();
      off = null;
      if (!phone.matches) return;
      off = pullToClose(el, {
        axis: "-x",
        can: () => el.classList.contains("is-open"),
        begin: () => {
          el.style.transition = "none";
          if (dim.current) dim.current.style.transition = "none";
        },
        move: (d) => {
          el.style.transform = `translateX(${-d}px)`;
          if (dim.current) dim.current.style.opacity = String(Math.max(0, 1 - Math.max(0, d) / el.offsetWidth));
        },
        end: (close) => {
          el.style.transition = "";
          el.style.transform = "";
          if (dim.current) {
            dim.current.style.transition = "";
            dim.current.style.opacity = "";
          }
          if (close) onClose();
        },
      });
    };
    wire();
    phone.addEventListener("change", wire);
    return () => {
      off?.();
      phone.removeEventListener("change", wire);
    };
  }, [onClose]);
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
      {/* The phone drawer's dim: always on the page, fading in and out with the drawer
          (globals.css `.ls-drawer-dim`), so it never pops. A tap on it only closes. */}
      <div
        ref={dim}
        onClick={onClose}
        className={cn("ls-drawer-dim lg:hidden", open && "is-open")}
        aria-hidden="true"
      />
      <aside
        ref={aside}
        style={{
          // The navy rail (Forge's frame, which began as this one): brand blue
          // down to navy, with its float shadow from globals.css `.app-rail`.
          // Gradient stays inline (Tailwind v4 @layer utilities don't reliably
          // emit it).
          background:
            "linear-gradient(180deg, #1b2273 0%, #151d67 34%, #0f172a 100%)",
          backgroundColor: "#0f172a",
        }}
        className={cn(
          // Mobile: a full-height drawer that slides in from the left on the sheet's
          // curve (globals.css `.app-rail` below lg). Desktop (lg): `.app-rail` makes
          // it a floating, inset, rounded, elevated card. No overflow clip: the chosen
          // Settings row's glow fades out past the footer, not against a straight edge.
          "app-rail fixed inset-y-0 left-0 z-50 flex w-64 flex-col",
          open && "is-open"
        )}
      >
        {/* Forge's brand row: the mark on a 34px white tile with a soft bloom behind
            it, beside the spaced wordmark, on one line. */}
        <div className="relative z-10 flex items-center justify-center px-4 pt-6 pb-4">
          <Link href={roleHomePath(role)} className="flex justify-start items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#c3ccff]">
            <span className="relative grid size-[34px] shrink-0 place-items-center">
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-3.5 rounded-full blur-[6px]"
                style={{
                  background:
                    "radial-gradient(closest-side, rgba(120,128,255,0.55), rgba(120,128,255,0) 70%)",
                }}
              />
              <span className="relative grid size-[34px] place-items-center rounded-[11px] bg-card bg-(image:--tex-white)">
                <Image src={leadstartMark} alt="LeadStart" priority className="h-[22px] w-auto" />
              </span>
            </span>
            <span
              className="-mr-[0.24em] text-[15px] font-bold uppercase leading-none tracking-[0.24em]"
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
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10 lg:hidden"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation. The chosen row's drop (4px down, 12px blur) reaches 8px above it
            and 16px below: the scroller's padding gives it that room on every side, the
            8px borrowed at the top paid back with a negative margin so the first row
            stays put, and the brand row above stacks over the borrowed strip to keep
            its presses (the glows rule). */}
        <nav className="-mt-2 flex-1 space-y-0.5 px-3 pt-3 pb-4 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {nav.map((item) => (
            <NavLink key={item.href} item={item} active={isNavActive(item, pathname)} />
          ))}
          <NavSection label="Sending" items={sendingNav} pathname={pathname} />
        </nav>

        {/* Footer: a single Settings entry pinned to the bottom. Replaces the
            old profile block; the top-right avatar menu already shows profile. */}
        {settingsItem && (
          <div className="border-t border-white/8 bg-black/12 p-3 lg:rounded-b-[20px]">
            <NavLink item={settingsItem} active={isNavActive(settingsItem, pathname)} />
          </div>
        )}
      </aside>
    </>
  );
}
