"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

/**
 * A menu, popover or list drawn by its owner (the topbar search's hits, a typeahead's matches, a picker's
 * panel), not by Base UI: the "Smooth transitions" rule's dropdown. It grows out of where it was pressed and
 * fades in over 220ms on the decelerating curve, goes back the same way a little quicker (160ms, ease-in),
 * stays on the page until it has gone (so it never pops out, and keeps the last thing it showed while it goes),
 * and pressed again mid-way turns round from where it is: its drawn opacity and scale are read and the new
 * motion starts from them. While it's leaving it takes no presses. Reduced motion: in and out at once.
 * `scripts/style/check-popups.mjs` holds every hand-drawn menu to it.
 */
const IN_MS = 220;
const OUT_MS = 160;
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
const SMALL = 0.96;

const still = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Grown({
  open,
  origin = "top left",
  className,
  style,
  children,
  ref,
  ...rest
}: {
  open: boolean;
  /** Where it grows from: the pressed thing's side (`transform-origin`). */
  origin?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
} & Omit<HTMLAttributes<HTMLDivElement>, "style" | "className" | "children">) {
  const el = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);
  // Mounted while open or on its way out.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const was = useRef(false);
  // What it showed last, kept while it goes: its owner may already have emptied it.
  const [kept, setKept] = useState(children);
  if (open && kept !== children) setKept(children);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const opening = open;
    if (opening === was.current && !motion.current) return;
    was.current = opening;
    // From where it's drawn now (mid-way, if it was going the other way), never from an end.
    const cs = getComputedStyle(node);
    const fromOpacity = motion.current ? Number(cs.opacity) || 0 : opening ? 0 : 1;
    const fromScale = motion.current ? (cs.scale === "none" ? 1 : Number(cs.scale.split(" ")[0]) || 1) : opening ? SMALL : 1;
    motion.current?.cancel();
    motion.current = null;
    // Reduce Motion: the end state at once (closed, the render below leaves it out).
    if (still()) return;
    const a = node.animate(
      [
        { opacity: fromOpacity, scale: String(fromScale) },
        { opacity: opening ? 1 : 0, scale: opening ? "1" : String(SMALL) },
      ],
      { duration: opening ? IN_MS : OUT_MS, easing: opening ? EASE_OUT : EASE_IN, fill: "both" },
    );
    motion.current = a;
    a.onfinish = () => {
      if (motion.current !== a) return;
      motion.current = null;
      if (!opening) setShown(false);
      else a.cancel();
    };
    a.oncancel = () => {
      if (motion.current === a) motion.current = null;
    };
  }, [open, shown]);

  if (!shown || (!open && still())) return null;
  return (
    <div
      ref={(node) => {
        el.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      data-grown={open ? "in" : "out"}
      inert={!open}
      className={className}
      style={{ transformOrigin: origin, ...style }}
      {...rest}
    >
      {open ? children : kept}
    </div>
  );
}
