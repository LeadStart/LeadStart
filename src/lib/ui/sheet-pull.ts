/**
 * Pulling a popup's sheet down to close it on a phone (components/ui/dialog.tsx,
 * alert-dialog.tsx). A port of Forge's lib/sheetPull.ts `pullToClose`: it follows
 * the finger, gives a little and no more if pulled up, and on letting go closes past
 * a third of its height or on a flick down, springing back otherwise.
 *
 * A popup's content often scrolls, so this listens to touches rather than pointers:
 * a drag on content that scrolls scrolls it, and pulls the sheet only from the top of
 * its scroll and only downwards, as iOS's own sheets do. It decides on the finger's
 * first few pixels and from then on cancels the touch's moves itself, so WebKit never
 * starts a scroll it would take over. A drag that starts in a text box, a drawing pad
 * or a slider, or goes sideways, stays theirs.
 */

/** How far the finger moves before it's a pull (or a scroll), not a tap. */
const SLOP = 6;
/** A flick: this fast down (px per ms), over at least this far, closes it whatever the distance. */
const FLICK = 0.5;
const FLICK_MIN = 12;
/** Pulled up, it gives this much at most. */
const STRETCH = 24;
/** Where a press is the touched thing's own, never a pull. */
const OWN = 'input, textarea, select, canvas, [contenteditable="true"], [data-no-pull]';

/** Past an end it can't go, the pull gives a little and no more. */
const give = (over: number) => Math.min(STRETCH, Math.sqrt(over) * 2);

/** The nearest box between the touch and the sheet that scrolls up and down and has more than it shows. */
function scrollerOf(from: Element | null, sheet: HTMLElement): HTMLElement | null {
  for (let el = from; el; el = el.parentElement) {
    if (
      el instanceof HTMLElement &&
      el.scrollHeight > el.clientHeight + 1 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY)
    )
      return el;
    if (el === sheet) break;
  }
  return null;
}

export function pullToClose(
  sheet: HTMLElement,
  o: {
    /** Whether it may be pulled now (not while it's leaving). */
    can: () => boolean;
    /** The finger has taken it (a pull, not a scroll or a tap). */
    begin: () => void;
    /** Where the finger has it: how far below its resting place (negative: stretched up). */
    move: (dy: number) => void;
    /** Let go: whether it closes, and where the finger left it. */
    end: (close: boolean, dy: number) => void;
  },
): () => void {
  const pulled = (dy: number) => (dy >= 0 ? dy : -give(-dy));
  let g: {
    x0: number;
    y0: number;
    pulling: boolean;
    scroller: HTMLElement | null;
    dy: number;
    trail: { y: number; t: number }[];
  } | null = null;

  const start = (e: TouchEvent) => {
    g = null;
    if (e.touches.length !== 1 || !o.can() || (e.target as Element).closest?.(OWN)) return;
    const t = e.touches[0];
    g = {
      x0: t.clientX,
      y0: t.clientY,
      pulling: false,
      scroller: scrollerOf(e.target as Element, sheet),
      dy: 0,
      trail: [{ y: t.clientY, t: e.timeStamp }],
    };
  };
  const move = (e: TouchEvent) => {
    if (!g) return;
    if (e.touches.length !== 1) return void finish(false);
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.pulling) {
      if (Math.hypot(dx, dy) < SLOP) return;
      // Sideways, or content that scrolls that way: not a pull. A move WebKit won't
      // let us cancel is already its scroll.
      const sc = g.scroller;
      const theirs = !!sc && (dy < 0 || sc.scrollTop > 0);
      if (Math.abs(dx) > Math.abs(dy) || !e.cancelable || theirs) return void (g = null);
      g.pulling = true;
      o.begin();
    }
    e.preventDefault();
    g.trail = [...g.trail.filter((s) => e.timeStamp - s.t < 90), { y: t.clientY, t: e.timeStamp }];
    g.dy = dy;
    o.move(pulled(dy));
  };
  const finish = (lifted: boolean) => {
    const was = g;
    g = null;
    if (!was?.pulling) return;
    const a = was.trail[0];
    const b = was.trail[was.trail.length - 1];
    const speed = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
    const dy = pulled(was.dy);
    o.end(lifted && (dy > sheet.offsetHeight / 3 || (speed > FLICK && dy > FLICK_MIN)), dy);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  sheet.addEventListener("touchstart", start, { passive: true });
  sheet.addEventListener("touchmove", move, { passive: false });
  sheet.addEventListener("touchend", up);
  sheet.addEventListener("touchcancel", cancel);
  return () => {
    sheet.removeEventListener("touchstart", start);
    sheet.removeEventListener("touchmove", move);
    sheet.removeEventListener("touchend", up);
    sheet.removeEventListener("touchcancel", cancel);
  };
}
