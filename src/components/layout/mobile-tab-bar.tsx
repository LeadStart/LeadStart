"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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

// Condense geometry: the pill spans the viewport minus a 16px inset each side,
// capped at 480px on tablets. On scroll-down it condenses to a glass dot round the
// active icon; scroll-up (or a route change) re-expands it. Everything moves on
// transforms and opacity (the "control that grows and shrinks" rule): the glass's
// two caps slide in and its stretch scales, the tabs slide toward the middle and
// fade, the active icon drops to the dot's middle as its label fades. The values are
// written straight to the DOM per scroll event (no React render, no layout) and a
// short linear transition smooths the steps between events, so nothing ever snaps.
const PILL_PAD = 5;
const MIN_W = 64; // condensed: the active icon on a glass dot
const CAP = 58; // the glass's end caps: a circle the pill's height
const CONDENSE_RANGE = 90; // px of scroll that takes the pill 0 -> fully condensed
const ICON_DROP = 7; // alone on the dot the icon sits in its middle: half its label's room (2 + 12)

/**
 * Mobile-only primary navigation: Forge's phone nav (task #228), a floating
 * brand-blue glass pill with a light capsule under the active tab that slides to
 * the next one as you move. Hidden at `lg` where the floating sidebar rail takes
 * over. Secondary surfaces still live behind the avatar menu ("All sections") in
 * the topbar. Styles: `globals.css` `.ls-mnav*`.
 */
export function MobileTabBar({ role }: { role: AppRole }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAdmin = role === "owner" || role === "va";
  const tabs = isAdmin ? adminTabs : role === "buyer" ? buyerTabs : clientTabs;

  const pillRef = useRef<HTMLElement>(null);
  const capL = useRef<HTMLSpanElement>(null);
  const capR = useRef<HTMLSpanElement>(null);
  const mid = useRef<HTMLSpanElement>(null);
  const halo = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const pRef = useRef(0);
  // The capsule lives in the active tab, so it rides with that tab. Between tabs it
  // slides (FLIP): where it stood before the route changed, measured as the old
  // capsule last stood, glides to the new tab.
  const glowRef = useRef<HTMLSpanElement>(null);
  const glowWas = useRef<DOMRect | null>(null);
  const noteGlow = useCallback(() => {
    if (glowRef.current) glowWas.current = glowRef.current.getBoundingClientRect();
  }, []);

  // Write the condense state (0 = full pill, 1 = active icon alone on the dot)
  // directly to the DOM. At rest (p~0) every inline style is cleared so the pill and
  // its tabs fall back to their CSS layout, which keeps the server-rendered markup
  // right and avoids a flash before this runs.
  const apply = useCallback(
    (raw: number) => {
      const p = Math.max(0, Math.min(1, raw));
      pRef.current = p;
      const pill = pillRef.current;
      if (!pill) return;
      const W = pill.clientWidth;
      pill.style.setProperty("--mnav-w", `${W}px`);
      const rest = p <= 0.001;
      const on = tabs.findIndex((t) => isActive(pathname, t.href, t.exact));
      const tabW = (W - PILL_PAD * 2) / tabs.length;
      const centre = W / 2;

      // The glass: its caps slide in by d (on whole device pixels, so the seams between
      // the pieces land on pixels), and the stretch between them scales to what's left.
      const dpr = window.devicePixelRatio || 1;
      const d = rest ? 0 : Math.round(((p * (W - MIN_W)) / 2) * dpr) / dpr;
      const s = (W - CAP - 2 * d) / (W - CAP);
      if (capL.current) capL.current.style.transform = rest ? "" : `translateX(${d}px)`;
      if (capR.current) capR.current.style.transform = rest ? "" : `translateX(${-d}px)`;
      if (mid.current) mid.current.style.transform = rest ? "" : `scaleX(${s.toFixed(4)})`;
      // The halo under the glass: one unclipped pill the glass's width, so its glow is never cut.
      if (halo.current) {
        halo.current.style.left = rest ? "" : `${d}px`;
        halo.current.style.width = rest ? "" : `${W - 2 * d}px`;
      }

      tabRefs.current.forEach((t, i) => {
        if (!t) return;
        const lab = t.querySelector<HTMLElement>(".ls-mnav-label");
        const icon = t.querySelector<SVGElement>(":scope > svg");
        const glow = t.querySelector<HTMLElement>(".ls-mnav-glow");
        if (rest) {
          t.style.transform = "";
          t.style.opacity = "";
          t.style.pointerEvents = "";
          if (lab) lab.style.opacity = "";
          if (icon) icon.style.transform = "";
          if (glow) glow.style.opacity = "";
          return;
        }
        // Every tab slides toward the pill's middle with the glass; the others fade out
        // before the glass has passed them, and take no taps once faded.
        const dx = (centre - (PILL_PAD + tabW * (i + 0.5))) * p;
        t.style.transform = `translateX(${dx.toFixed(1)}px)`;
        if (i === on) {
          t.style.opacity = "";
          t.style.pointerEvents = "";
          if (lab) lab.style.opacity = (1 - p).toFixed(3);
          if (icon) icon.style.transform = `translateY(${(ICON_DROP * p).toFixed(2)}px)`;
          if (glow) glow.style.opacity = Math.max(0, 1 - p * 2).toFixed(3);
        } else {
          const o = Math.max(0, 1 - p * 1.8);
          t.style.opacity = o.toFixed(3);
          t.style.pointerEvents = o < 0.05 ? "none" : "";
          if (lab) lab.style.opacity = "";
          if (icon) icon.style.transform = "";
        }
      });
    },
    [pathname, tabs],
  );

  // Route change (a tab tap or any navigation): the pill re-expands round the new
  // active tab before the capsule's slide is measured, so the slide starts and ends
  // at rest. Runs on mount too, where it only clears inline styles.
  useLayoutEffect(() => {
    apply(0);
    const el = glowRef.current;
    const was = glowWas.current;
    if (!el) return;
    const now = el.getBoundingClientRect();
    glowWas.current = now;
    if (!was || Math.abs(was.left - now.left) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [
        { transform: `translateX(${was.left - now.left}px) scaleX(${was.width / now.width})` },
        { transform: "none" },
      ],
      { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
    );
  }, [pathname, apply]);

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
        <span className="ls-mnav-glass" aria-hidden>
          <span ref={halo} className="ls-mnav-halo" />
          <span ref={capL} className="ls-mnav-capbox l">
            <span className="ls-mnav-cap" />
          </span>
          <span ref={mid} className="ls-mnav-midbox">
            <span className="ls-mnav-mid" />
          </span>
          <span ref={capR} className="ls-mnav-capbox r">
            <span className="ls-mnav-cap" />
          </span>
        </span>
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
              onPointerDown={noteGlow}
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
              {active && <span ref={glowRef} className="ls-mnav-glow" aria-hidden />}
              {tab.icon}
              <span className="ls-mnav-label">{tab.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
