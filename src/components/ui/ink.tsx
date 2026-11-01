"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { inkRegister, inkRelease } from "@/lib/ui/ink-center";

/**
 * A count, an initial or a symbol alone in a pill, ring, badge or avatar, sat on its ink (the icons rule; the
 * measuring is src/lib/ui/ink-center.ts). It registers its span only once React has mounted it, so the slide is
 * never written on server HTML before it has hydrated: done from a DOM watch, the `translate` landed on the inbox
 * rows' initials before React reached them, and React 19 reported an attribute mismatch on every row (2026-10-31).
 * Never write `<span data-ink>` by hand; scripts/style/check-icon-centers.mjs fails one.
 */
export function Ink({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    inkRegister(el);
    return () => inkRelease(el);
  }, [children, className]);
  return (
    <span data-ink className={className} ref={ref}>
      {children}
    </span>
  );
}
