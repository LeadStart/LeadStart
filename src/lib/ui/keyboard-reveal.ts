"use client";

import { boxAt, caretToEnd, isTextField, kindOf, recall, remember, reportedHeight, touch } from "@/lib/ui/sheet-keyboard";
import { bezier } from "@/lib/ui/fold";

/**
 * Text boxes on a phone are never under the keyboard (the "Text boxes on a phone" rule; a port of the reveal in
 * Forge's phone bridge, made for Safari). Installed once (components/layout/keyboard-reveal.tsx), on touch screens
 * only. A box partway down a page is looked after here; a box in a popup's sheet is the sheet's (sheet-keyboard.ts).
 * - A tap on a box takes the cursor from here, with `preventScroll`, so iOS never slides the page to show it; a
 *   slide iOS makes anyway is put back.
 * - The moment the box has the cursor it's brought about 16px above the keyboard in its page's own scroller, sized
 *   for that kind of keyboard's last height, gliding on the keyboard's clock (up 240ms on CSS ease, down 200ms),
 *   and corrected when Safari reports the keyboard; a box already in view stays put. Room is lent at the page's
 *   foot when it can't scroll that far, and given back once giving it back would move nothing. A box whose
 *   scroller is pinned under the keyboard (a tab panel in a workspace of fixed height, held sideways) has that
 *   scroller brought up in its own first, out to the page, so the box has room to come above the keyboard.
 * - A box is brought into view once, and again only when the keyboard's height changes or the box grows (an
 *   `input` listener keeps a growing box where it was, before iOS looks).
 * - Everything around the box holds still while you type: a drag that no scroller under the finger can take
 *   (the page the box sits on, the bars) is cancelled; a scroller that doesn't hold the box and can move that way,
 *   or the box's own text when it's longer than the box, keeps its drag. A guard never traps a bad layout: the
 *   hold lets go whenever the box isn't fully in view.
 * - The box is never taller than the room between the page's top and the keyboard: past that its text scrolls
 *   inside. Blur ends keyboard mode in the same frame, and nothing moves the page back.
 * `scripts/style/check-textboxes.mjs` makes every multi-line box say which way it's looked after.
 */
const UP = { ms: 240, curve: [0.25, 0.1, 0.25, 1] as const };
const DOWN = { ms: 200, curve: [0.4, 0, 0.2, 1] as const };
/** The box's foot sits this far above the keyboard, its top this far below the scroller's top. */
const GAP = 16;
const TOP_GAP = 12;
/** Under this much room the box isn't capped: what's left of it shows, its top first. */
const MIN_ROOM = 48;
/** A popup's sheet looks after its own boxes. */
const SHEET = ".ls-pop";

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The box a page field scrolls in: the nearest ancestor that scrolls up and down, else the page itself. */
function scrollerOf(f: Element): HTMLElement {
  for (let n = f.parentElement; n && n !== document.body; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
  }
  return document.scrollingElement as HTMLElement;
}
const isPage = (sc: HTMLElement) => sc === document.scrollingElement;
/** Whether a scroller can move the way a finger drags (up: the content comes up, so it needs room below). */
const canMove = (el: Element, dy: number) =>
  dy < 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 0.5 : el.scrollTop > 0.5;

export function keyboardReveal(): () => void {
  if (typeof window === "undefined" || !touch()) return () => {};
  const vv = window.visualViewport;
  const root = document.documentElement;
  let field: HTMLElement | null = null;
  let kind = "";
  /** The keyboard's height the page is laid out for (0: none). */
  let height = 0;
  let peak = 0;
  let settle = 0;
  let undos = 0;
  let fingers = 0;
  let tapped: HTMLElement | null = null;
  let refocusing = false;
  let raf = 0;
  /** Room lent at scrollers' feet: each one's padding before, its padding then, and how much was lent. */
  const lent = new Map<HTMLElement, { was: string; base: number; px: number }>();
  /** The field's least size before this took it (a box taller than its room keeps its text scrolling inside). */
  let capped: { f: HTMLElement; maxHeight: string; overflowY: string } | null = null;

  /** The keyboard's top in the page's coordinates: `kb` above what the page can see without it (reportedHeight). */
  const foot = (kb: number) => window.innerHeight - kb;
  const lendTarget = (sc: HTMLElement) => (isPage(sc) ? document.body : sc);

  const unlend = (force = false) => {
    for (const [sc, { was, px }] of lent) {
      const max = sc.scrollHeight - sc.clientHeight;
      // Given back only once that moves nothing: the view sits above the lent room, or nothing has the cursor
      // and the room is empty.
      if (!force && sc.scrollTop > max - px + 0.5) continue;
      lendTarget(sc).style.paddingBottom = was;
      lent.delete(sc);
    }
  };
  /** Lends `px` more at `sc`'s foot. */
  const lend = (sc: HTMLElement, px: number) => {
    const target = lendTarget(sc);
    const had = lent.get(sc);
    if (had) {
      had.px += px;
      target.style.paddingBottom = `${had.base + had.px}px`;
      return;
    }
    const was = target.style.paddingBottom;
    const base = parseFloat(getComputedStyle(target).paddingBottom) || 0;
    target.style.paddingBottom = `${base + px}px`;
    lent.set(sc, { was, base, px });
  };
  /** Where `sc` can scroll to reach `to`: room is lent at its foot past its end. */
  const reach = (sc: HTMLElement, to: number) => {
    const max = sc.scrollHeight - sc.clientHeight;
    if (to > max) lend(sc, Math.ceil(to - max));
    return Math.max(0, Math.min(to, sc.scrollHeight - sc.clientHeight));
  };
  const uncap = () => {
    if (!capped) return;
    capped.f.style.maxHeight = capped.maxHeight;
    capped.f.style.overflowY = capped.overflowY;
    capped = null;
  };

  const cancelGlide = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  type Move = { sc: HTMLElement; to: number };
  /**
   * Scrolls each of `moves` from where it is to its `to`, together, on the keyboard's own clock and curve. Held
   * at its start: it plays from the second frame, and starts again from 40ms in after a hold in drawing (a gap
   * over 50ms within its first 400ms), as iOS holds the page's drawing while the keyboard starts.
   */
  const glideScroll = (moves: Move[], how: "clock" | null) => {
    cancelGlide();
    const runs = moves.map((m) => ({ ...m, from: m.sc.scrollTop })).filter((m) => Math.abs(m.to - m.from) >= 0.5);
    if (!runs.length) return;
    if (!how || still()) {
      for (const m of runs) m.sc.scrollTop = m.to;
      return;
    }
    const { ms, curve } = runs.some((m) => m.to > m.from) ? UP : DOWN;
    const ease = bezier(curve);
    let frames = 0;
    let begin = 0;
    let last = 0;
    let again = false;
    const step = (t: number) => {
      frames++;
      if (frames === 1) {
        last = t;
        raf = requestAnimationFrame(step);
        return;
      }
      if (frames === 2) begin = t;
      else if (!again && t - last > 50 && t - begin < 400) {
        again = true;
        begin = t - 40;
      }
      last = t;
      const p = Math.min(1, (t - begin) / ms);
      const at = ease(p);
      for (const m of runs) m.sc.scrollTop = m.from + (m.to - m.from) * at;
      if (p < 1) raf = requestAnimationFrame(step);
      else raf = 0;
    };
    raf = requestAnimationFrame(step);
  };

  /** The box's scrollers, its own first, out to the page; the page itself only when no other holds the box. */
  const scrollersOf = (f: HTMLElement) => {
    const out: HTMLElement[] = [];
    for (let sc = scrollerOf(f); !isPage(sc); sc = scrollerOf(sc)) out.push(sc);
    return out.length ? out : [document.scrollingElement as HTMLElement];
  };
  /** Where `sc`'s top will be once outer scrollers have brought everything inside them up by `shifted`. */
  const topOf = (sc: HTMLElement, shifted = 0) => (isPage(sc) ? 0 : sc.getBoundingClientRect().top - shifted);

  /**
   * Brings `f` above `kb` px of keyboard in its scroller; a box already in view stays put. A scroller pinned
   * under the keyboard (a tab panel in a workspace of fixed height, held sideways) is brought up in its own
   * first, out to the page, each lent room at its foot when it can't scroll that far.
   */
  const reveal = (f: HTMLElement, kb: number, how: "clock" | null) => {
    const scs = scrollersOf(f);
    const end = foot(kb) - GAP;
    const fh = f.getBoundingClientRect().height;
    // Inside out: how high each scroller must come for the whole box to show, until one already is.
    const wants: number[] = [];
    let want = end - TOP_GAP - fh;
    for (let i = 0; i < scs.length - 1 && topOf(scs[i]) > want + 0.5; i++) {
      wants.push(want);
      want -= TOP_GAP;
    }
    // Outside in: each outer scroller brings the one inside it up to what it wants, or to its own head.
    const moves: Move[] = [];
    let shifted = 0;
    for (let i = wants.length - 1; i >= 0; i--) {
      const outer = scs[i + 1];
      const dy = topOf(scs[i], shifted) - Math.max(wants[i], topOf(outer, shifted) + TOP_GAP);
      if (dy < 1) continue;
      const to = reach(outer, outer.scrollTop + dy);
      moves.push({ sc: outer, to });
      shifted += to - outer.scrollTop;
    }
    const sc = scs[0];
    const head = topOf(sc, shifted) + TOP_GAP;
    const room = end - head;
    // Never taller than the room: past that its text scrolls inside, the cursor's line in sight.
    if (room >= MIN_ROOM && fh > room && !(capped && capped.f === f)) {
      capped = { f, maxHeight: f.style.maxHeight, overflowY: f.style.overflowY };
      f.style.maxHeight = `${Math.floor(room)}px`;
      f.style.overflowY = "auto";
    }
    const r = f.getBoundingClientRect();
    const top = r.top - shifted;
    const bottom = r.bottom - shifted;
    let dy = 0;
    if (r.height > room) dy = top - head;
    else if (bottom > end) dy = bottom - end;
    else if (top < head) dy = top - head;
    if (Math.abs(dy) >= 1) moves.push({ sc, to: reach(sc, sc.scrollTop + dy) });
    glideScroll(moves, how);
  };

  /** Safari's word on the keyboard: met where the guess was off, and kept for next time. */
  const report = (settled = false) => {
    if (!field) return;
    const h = reportedHeight();
    if (!h) {
      // No keyboard after all (a hardware keyboard), or it went with the box keeping the cursor.
      if (height && (settled || peak)) {
        peak = 0;
        height = 0;
        uncap();
      }
      return;
    }
    peak = settled ? h : Math.max(peak, h);
    remember(kind, peak);
    // iOS slid the page to bring the box to the middle: put back, so the layout under the keyboard holds.
    const sc = scrollerOf(field);
    if (vv && !isPage(sc) && (vv.offsetTop > 0 || window.scrollY > 0) && !fingers && undos < 4) {
      undos++;
      window.scrollTo(0, 0);
      requestAnimationFrame(() => report());
    }
    if (peak === height) return;
    height = peak;
    reveal(field, height, "clock");
  };

  const onFocusIn = (e: FocusEvent) => {
    const f = e.target;
    if (refocusing || !isTextField(f) || f.closest(SHEET)) return;
    // The keyboard's arrows move the cursor without a tap: taken again with preventScroll, so iOS doesn't
    // slide the page to bring the box to the middle.
    if (height && f !== tapped) {
      refocusing = true;
      f.blur();
      f.focus({ preventScroll: true });
      refocusing = false;
    }
    const was = kind;
    if (capped && capped.f !== f) uncap();
    field = f;
    kind = kindOf(f);
    peak = 0;
    undos = 0;
    window.clearTimeout(settle);
    settle = window.setTimeout(() => report(true), 700);
    if (height && kind === was) return reveal(f, height, "clock");
    // Only a box a finger tapped brings a keyboard: one given the cursor by code has none.
    const guess = f === tapped ? recall(kind) : 0;
    if (guess) {
      height = guess;
      reveal(f, guess, "clock");
    }
  };
  const onFocusOut = (e: FocusEvent) => {
    if (refocusing || !isTextField(e.target) || (e.target as HTMLElement).closest(SHEET)) return;
    if (isTextField(e.relatedTarget)) return;
    // Keyboard mode ends in the same frame; nothing moves the page back.
    field = null;
    kind = "";
    peak = 0;
    height = 0;
    window.clearTimeout(settle);
    cancelGlide();
    uncap();
    unlend();
  };

  // A tap on a box: the box takes the cursor from here, with preventScroll.
  let press: { x: number; y: number; t: number; f: HTMLElement } | null = null;
  let drag: { x: number; y: number; target: Element } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    fingers = e.touches.length;
    press = null;
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) return (drag = null);
    drag = { x: t.clientX, y: t.clientY, target: e.target as Element };
    if ((e.target as Element).closest?.(SHEET)) return;
    const f = boxAt(document.body, e.target as Element, t.clientX, t.clientY);
    if (!f || f.closest(SHEET)) return;
    if (f === document.activeElement && height) return;
    press = { x: t.clientX, y: t.clientY, t: e.timeStamp, f };
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (press && t && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) press = null;
    if (!field || !height || !drag || !t || !e.cancelable) return;
    // The hold lets go whenever the box isn't fully in view.
    const r = field.getBoundingClientRect();
    if (r.top < 0 || r.bottom > foot(height) + 0.5) return;
    const dx = t.clientX - drag.x;
    const dy = t.clientY - drag.y;
    if (Math.abs(dx) > Math.abs(dy)) return;
    const target = drag.target;
    // The box's own text, when it's longer than the box.
    const own = target.closest?.("textarea, input, [contenteditable]");
    if (own === field && field.scrollHeight > field.clientHeight + 1 && canMove(field, dy)) return;
    // A scroller that doesn't hold the box and can move that way.
    for (let n: Element | null = target; n && n !== document.body; n = n.parentElement) {
      if (n.contains(field)) break;
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1) {
        if (canMove(n, dy)) return;
        break;
      }
    }
    e.preventDefault();
  };
  const onTouchEnd = (e: TouchEvent) => {
    fingers = e.touches.length;
    const p = press;
    press = null;
    drag = null;
    if (!fingers) report();
    if (!p || e.timeStamp - p.t > 500 || !p.f.isConnected) return;
    e.preventDefault();
    tapped = p.f;
    if (document.activeElement === p.f) p.f.blur();
    p.f.focus({ preventScroll: true });
    tapped = null;
    caretToEnd(p.f);
  };
  const onTouchCancel = (e: TouchEvent) => {
    fingers = e.touches.length;
    press = null;
    drag = null;
  };
  // A box that grows as you type: kept where it was brought, before iOS scrolls the page to put the cursor mid-view.
  const onInput = (e: Event) => {
    if (!field || e.target !== field || !height) return;
    const sc = scrollerOf(field);
    const end = foot(height) - GAP;
    const r = field.getBoundingClientRect();
    if (r.bottom <= end + 0.5) return;
    const to = reach(sc, sc.scrollTop + (r.bottom - end));
    cancelGlide();
    sc.scrollTop = to;
  };
  const onScroll = () => {
    if (!field) unlend();
  };
  const onReport = () => report();

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  window.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  window.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
  window.addEventListener("input", onInput);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  vv?.addEventListener("resize", onReport);
  vv?.addEventListener("scroll", onReport);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("touchstart", onTouchStart, { capture: true });
    window.removeEventListener("touchmove", onTouchMove, { capture: true });
    window.removeEventListener("touchend", onTouchEnd, { capture: true });
    window.removeEventListener("touchcancel", onTouchCancel, { capture: true });
    window.removeEventListener("input", onInput);
    document.removeEventListener("scroll", onScroll, { capture: true });
    vv?.removeEventListener("resize", onReport);
    vv?.removeEventListener("scroll", onReport);
    window.clearTimeout(settle);
    cancelGlide();
    uncap();
    unlend(true);
  };
}
