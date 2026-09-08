"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
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

// Buyer portal.
const buyerTabs: Tab[] = [
  { href: "/buyer", label: "Home", icon: <LayoutDashboard size={22} />, exact: true },
  { href: "/buyer/search", label: "Search", icon: <Sparkles size={22} /> },
  { href: "/buyer/contacts", label: "Contacts", icon: <Users size={22} /> },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

// Condense geometry (mirrors ReciFeast's floating-nav, adapted to a centred pill
// with no search circle): the pill spans the viewport minus a 16px inset each
// side, capped at 480px on tablets. On scroll-down it shrinks toward the active
// tab only; scroll-up (or a route change) re-expands it. Widths are written
// straight to the DOM per scroll event (no React render) and short CSS
// transitions smooth the steps, so nothing ever snaps.
const SIDE_INSET = 16;
const PILL_PAD = 6;
const MIN_W = 64; // condensed pill: active icon + padding
const TAB_MIN_ON = 48; // active tab collapsed to icon-only
const LABEL_MAX_W = 64;
const CONDENSE_RANGE = 90; // px of scroll that takes the pill 0 -> fully condensed

/**
 * Mobile-only primary navigation. A floating Liquid-Glass pill (ReciFeast-style,
 * approved by Daniel 2026-09-08) that replaces the hamburger as the main way
 * around on phones/tablets; hidden at `lg` where the floating sidebar rail takes
 * over. Secondary surfaces still live behind the avatar menu ("All sections") in
 * the topbar. The glass material is a sanctioned exemption to the flat contract
 * (see `globals.css` `.ls-mnav*` + UI_RULES.md).
 */
export function MobileTabBar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = role === "owner" || role === "va";
  const tabs = isAdmin ? adminTabs : role === "buyer" ? buyerTabs : clientTabs;

  const pillRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const pRef = useRef(0);

  // Write the condense state (0 = full pill, 1 = active tab only) directly to the
  // DOM. At rest (p≈0) all inline styles are cleared so the pill/tabs fall back to
  // their CSS flex layout — that keeps the server-rendered markup correct and
  // avoids a flash before this runs.
  const apply = useCallback(
    (raw: number) => {
      const p = Math.max(0, Math.min(1, raw));
      pRef.current = p;
      const pill = pillRef.current;
      if (!pill) return;

      if (p <= 0.001) {
        pill.style.width = "";
        pill.classList.remove("is-min");
        tabRefs.current.forEach((t) => {
          if (!t) return;
          t.style.flex = "";
          t.style.width = "";
          t.style.opacity = "";
          t.style.paddingLeft = "";
          t.style.paddingRight = "";
          t.style.gap = "";
          const lab = t.querySelector<HTMLElement>("span");
          if (lab) {
            lab.style.maxWidth = "";
            lab.style.maxHeight = "";
            lab.style.opacity = "";
          }
        });
        return;
      }

      const restW = Math.min(window.innerWidth - SIDE_INSET * 2, 480);
      const tabW = (restW - PILL_PAD * 2) / tabs.length;
      pill.style.width = `${(restW - p * (restW - MIN_W)).toFixed(1)}px`;
      pill.classList.toggle("is-min", p > 0.98);

      tabRefs.current.forEach((t, i) => {
        if (!t) return;
        const on = isActive(pathname, tabs[i].href, tabs[i].exact);
        const lab = t.querySelector<HTMLElement>("span");
        t.style.flex = "0 0 auto";
        if (on) {
          t.style.width = `${(tabW - p * (tabW - TAB_MIN_ON)).toFixed(1)}px`;
          t.style.gap = `${((1 - p) * 2).toFixed(2)}px`;
          t.style.opacity = "1";
          t.style.paddingLeft = t.style.paddingRight = "10px";
          if (lab) {
            lab.style.maxWidth = `${((1 - p) * LABEL_MAX_W).toFixed(1)}px`;
            lab.style.maxHeight = `${((1 - p) * 14).toFixed(1)}px`;
            lab.style.opacity = String(1 - p);
          }
        } else {
          t.style.width = `${((1 - p) * tabW).toFixed(1)}px`;
          t.style.opacity = String(1 - p);
          t.style.paddingLeft = t.style.paddingRight = `${(10 * (1 - p)).toFixed(1)}px`;
          t.style.gap = "2px";
          if (lab) {
            lab.style.maxWidth = `${LABEL_MAX_W}px`;
            lab.style.maxHeight = "14px";
            lab.style.opacity = "1";
          }
        }
      });
    },
    [pathname, tabs],
  );

  // Route change (a tab tap or any navigation) → the pill re-expands around the
  // new active tab. Runs on mount too; harmless because at rest it only clears
  // inline styles.
  useEffect(() => {
    apply(0);
  }, [apply]);

  // Scroll-linked condense, plus re-layout on viewport resize. The shell's
  // `.app-shell-content` is the scroll container below `lg`; if it isn't present
  // (or the user prefers reduced motion) the pill simply stays fully expanded.
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const scroller = document.querySelector<HTMLElement>(".app-shell-content");
    if (!scroller) return;

    let last = scroller.scrollTop;
    const onScroll = () => {
      const st = scroller.scrollTop;
      const delta = st - last;
      last = st;
      const next = st <= 4 ? 0 : pRef.current + delta / CONDENSE_RANGE;
      apply(next);
    };
    const onResize = () => apply(pRef.current);

    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [apply]);

  return (
    <div className="ls-mnav lg:hidden">
      <nav ref={pillRef} className="ls-mnav-pill" aria-label="Primary">
        {tabs.map((tab, i) => {
          const active = isActive(pathname, tab.href, tab.exact);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              aria-current={active ? "page" : undefined}
              className={cn("ls-mnav-tab", active && "is-on")}
              onClick={(e) => {
                // Tapping the tab you're already on: scroll the page back to the
                // top (which also re-expands a condensed pill) and refresh its
                // data, instead of a dead re-navigation. Sub-routes (active by
                // prefix) fall through to normal navigation to the tab root.
                if (pathname !== tab.href) return;
                e.preventDefault();
                document
                  .querySelector<HTMLElement>(".app-shell-content")
                  ?.scrollTo({ top: 0, behavior: "smooth" });
                apply(0);
                router.refresh();
              }}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
