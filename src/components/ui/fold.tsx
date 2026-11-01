"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { glidePage, reducedMotion, snapFold, trackGlide, type FoldGlide, type FoldSnap } from "@/lib/ui/fold";

/**
 * The one way a part opens and closes in place (the "Expand and collapse: one shared fold" rule; a port of
 * Forge's components/Fold.tsx). Draw what a button shows and hides as `<Fold open={open}>…</Fold>`, the button
 * saying `aria-expanded`; `scripts/style/check-folds.mjs` holds every fold to it.
 *
 * What's inside is mounted while it's open or closing, and gone once closed, as `{open && …}` was. It opens on
 * the fold's clock (lib/ui/fold.ts: 220ms, closing in 160ms), fading in where its room is opening and out a
 * little quicker as it closes, and pressed again mid-way it turns round from where it's drawn. Its room glides
 * between explicit heights, clipped only while it moves and back at `auto` at rest, and what's under it moves
 * with it.
 *
 * `inner` styles the layer that holds what opens (a column with its own gap: a parent's gap would count a
 * closed fold). `closed` swaps a peek for the whole thing, crossfading on the one clock as its height glides
 * between the two; `overlap` when the open one starts with the closed one's words, so they never dim. `grows`:
 * content that arrives after it's open (a list read from the server) glides its room too.
 */
export function Fold({
  open,
  closed,
  overlap = false,
  grows = false,
  inner,
  className,
  style,
  id,
  children,
}: {
  open: boolean;
  closed?: ReactNode;
  overlap?: boolean;
  grows?: boolean;
  inner?: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const peek = useRef<HTMLDivElement>(null);
  // What's kept on the page while it goes: the open part while closing, the closed one while opening.
  const [keptOpen, setKeptOpen] = useState(open);
  const [keptClosed, setKeptClosed] = useState(!open);
  if (open && !keptOpen) setKeptOpen(true);
  if (!open && !keptClosed) setKeptClosed(true);
  const swap = closed !== undefined;
  const showOpen = open || keptOpen;
  const showClosed = swap && (!open || keptClosed);

  // How it stands the moment before this press, read while the page still shows it.
  const committed = useRef(open);
  const snap = useRef<FoldSnap | null>(null);
  if (open !== committed.current && !snap.current && box.current) snap.current = snapFold(box.current);

  const glide = useRef<FoldGlide | null>(null);
  const after = useRef<(() => void) | undefined>(undefined);
  const run = (g: FoldGlide, then?: () => void) => {
    glide.current = g;
    after.current = then;
    if (box.current) trackGlide(box.current, g.finished);
    void g.finished.then(() => {
      if (glide.current !== g) return;
      glide.current = null;
      after.current = undefined;
      then?.();
    });
  };

  useLayoutEffect(() => {
    if (open === committed.current) return;
    committed.current = open;
    const s = snap.current;
    snap.current = null;
    const el = box.current;
    const arrive = open ? layer.current : peek.current;
    const leave = open ? peek.current : layer.current;
    // Whatever was going ends first, and nothing it hid stays hidden.
    glide.current?.end();
    glide.current = null;
    after.current = undefined;
    for (const l of [arrive, leave]) if (l) l.style.visibility = "";
    const gone = () => (open ? setKeptClosed(false) : setKeptOpen(false));
    if (!el || !s || reducedMotion()) {
      if (el) el.style.height = el.style.overflowY = "";
      return gone();
    }
    run(glidePage(el, arrive, leave, s, open, overlap), gone);
    // Its own state only: `overlap` is read as it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Closed and emptied, it rests at nothing with no sizes of its own left.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !showOpen && !showClosed) el.style.height = el.style.overflowY = "";
  }, [showOpen, showClosed]);

  useLayoutEffect(
    () => () => {
      glide.current?.end();
    },
    [],
  );

  // Content arriving once it's open glides its room as well, from where it's drawn.
  useLayoutEffect(() => {
    const el = box.current;
    const what = layer.current;
    if (!grows || !open || !el || !what) return;
    let last = what.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const now = what.getBoundingClientRect().height;
      const grew = now - last;
      last = now;
      if (Math.abs(grew) < 0.5 || reducedMotion()) return;
      const going = glide.current;
      const s: FoldSnap = going
        ? snapFold(el)
        : { height: el.getBoundingClientRect().height - grew, opacity: new Map([[what, 1]]) };
      const then = after.current;
      going?.end();
      run(glidePage(el, what, null, s, true, false), then);
    });
    ro.observe(what);
    return () => ro.disconnect();
  }, [grows, open, showOpen]);

  return (
    <div ref={box} id={id} className={`fold${className ? ` ${className}` : ""}`} style={style}>
      {showClosed && (
        <div ref={peek} className={`fold-peek${open ? " fold-out" : ""}`} inert={open}>
          {closed}
        </div>
      )}
      {showOpen && (
        <div ref={layer} className={`fold-in${inner ? ` ${inner}` : ""}${!open ? " fold-out" : ""}`} inert={!open}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The props of a header that opens and closes a fold (a card's clickable header, a row): a button to the
 * keyboard and to `scripts/style/check-folds.mjs`, which pairs every `aria-expanded` with a `<Fold>`.
 */
export function foldToggle(open: boolean, toggle: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-expanded": open,
    onClick: toggle,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    },
  };
}
