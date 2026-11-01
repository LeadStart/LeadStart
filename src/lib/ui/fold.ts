/**
 * A part opening and closing in place (components/ui/fold.tsx; the "Expand and collapse: one shared fold" rule,
 * a port of Forge's lib/fold.ts for a page). One clock for every fold: it opens over OPEN_MS on the dropdowns'
 * decelerating curve and closes a little quicker on an ease-in, as "Smooth transitions" has it. Pressed again
 * mid-way it turns round from where it's drawn, never from its end. `scripts/style/check-folds.mjs` holds these.
 */
export const OPEN_MS = 220;
export const CLOSE_MS = 160;
export const OPEN_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
export const CLOSE_EASE = "cubic-bezier(0.4, 0, 1, 1)";

/** The two curves as numbers, for a glide drawn a frame at a time (`wholeGlide`). */
const OPEN_CURVE = [0.2, 0.8, 0.2, 1] as const;
const CLOSE_CURVE = [0.4, 0, 1, 1] as const;

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const foldTiming = (opening: boolean, ms?: number): KeyframeAnimationOptions => ({
  duration: ms ?? (opening ? OPEN_MS : CLOSE_MS),
  easing: opening ? OPEN_EASE : CLOSE_EASE,
  fill: "forwards",
});

/** How a fold stood the moment before it was pressed: read as React draws its new state, while the page shows the old. */
export interface FoldSnap {
  /** The fold's drawn height (mid-glide too). */
  height: number;
  /** Each layer's drawn opacity. */
  opacity: Map<Element, number>;
}

export function snapFold(box: HTMLElement): FoldSnap {
  const opacity = new Map<Element, number>();
  for (const layer of box.children) opacity.set(layer, Number(getComputedStyle(layer).opacity) || 0);
  return { height: box.getBoundingClientRect().height, opacity };
}

/** The layers' fades: the one arriving in, the one leaving out, each from where it's drawn. */
function fades(
  arrive: HTMLElement | null,
  leave: HTMLElement | null,
  snap: FoldSnap,
  overlap: boolean,
  timing: KeyframeAnimationOptions,
) {
  const out: Animation[] = [];
  const at = (el: Element, fallback: number) => snap.opacity.get(el) ?? fallback;
  // A swap of one thing for another turns: the old fades over the first part, the new in over the rest, so they
  // never show through each other. When the new one starts with the old one's words, the new comes in first and
  // the old goes after, so the words they share never dim.
  const swap = !!arrive && !!leave;
  if (arrive) {
    const from = at(arrive, 0);
    const frames: Keyframe[] =
      swap && !overlap
        ? [{ opacity: from, offset: 0 }, { opacity: from, offset: 0.4 }, { opacity: 1, offset: 1 }]
        : swap
          ? [{ opacity: from, offset: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 1, offset: 1 }]
          : [{ opacity: from }, { opacity: 1 }];
    out.push(arrive.animate(frames, timing));
  }
  if (leave) {
    const from = at(leave, 1);
    const frames: Keyframe[] =
      swap && !overlap
        ? [{ opacity: from, offset: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 0, offset: 1 }]
        : swap
          ? [{ opacity: from, offset: 0 }, { opacity: from, offset: 0.5 }, { opacity: 0, offset: 1 }]
          : [{ opacity: from }, { opacity: 0 }];
    out.push(leave.animate(frames, timing));
  }
  return out;
}

/** Each fold's glide going on, so what's inside can wait for it to land (`landed`). */
const gliding = new WeakMap<Element, Promise<void>>();
export function trackGlide(box: Element, finished: Promise<void>) {
  gliding.set(box, finished);
  void finished.then(() => gliding.get(box) === finished && gliding.delete(box));
}
/**
 * Once the fold an element is in has landed (at once if it isn't moving). What's inside that brings itself into
 * view waits for this: scrolled while its fold still grew, the page's scroll and the fold's glide add up, and
 * what's under it bobs.
 */
export async function landed(el: Element | null | undefined): Promise<void> {
  const box = el?.closest(".fold");
  for (let p = box && gliding.get(box); p; p = gliding.get(box!)) await p;
}

export interface FoldGlide {
  /** Ends it where it's going: its resting layout, no inline sizes left. */
  end: () => void;
  finished: Promise<void>;
}

/**
 * In a page or a list: its room glides between explicit heights, from the height it's drawn at, clipped only while
 * it moves and left at `auto` at rest, so it follows its width. What's under it moves with it. The new layout is in
 * when this is called: the arriving layer in flow, the leaving one laid over it (`.fold-out`).
 */
export function glidePage(
  box: HTMLElement,
  arrive: HTMLElement | null,
  leave: HTMLElement | null,
  snap: FoldSnap,
  opening: boolean,
  overlap: boolean,
): FoldGlide {
  // Where it rests: its own height with the new layout in (margins and all, as `.fold` holds them).
  box.style.height = box.style.overflowY = "";
  const to = arrive ? box.getBoundingClientRect().height : 0;
  const from = snap.height;
  const timing = foldTiming(opening);
  // Clipped top and foot only: a row's shadow at its sides stays drawn.
  box.style.overflowY = "clip";
  box.style.height = `${from}px`;
  const anims = fades(arrive, leave, snap, overlap, timing);
  // In whole pixels, on a clock that moves by the frames drawn (`fold-whole`, for a fold over a scroller's lines).
  const room = box.classList.contains("fold-whole")
    ? wholeGlide(box, from, to, opening, anims)
    : box.animate([{ height: `${from}px` }, { height: `${to}px` }], timing);
  return settle(room, anims, () => {
    // Open, it's left at its own height; closed, at nothing until what's inside has gone.
    box.style.height = arrive ? "" : "0px";
    box.style.overflowY = arrive ? "" : "clip";
    if (leave) leave.style.visibility = "hidden";
  });
}

/** A cubic-bezier easing as a function of time (0 to 1), as CSS draws it. */
export function bezier([x1, y1, x2, y2]: readonly number[]): (t: number) => number {
  const at = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

interface Room {
  cancel: () => void;
  finished: Promise<unknown>;
}
/** The most a fold's clock moves on in one drawn frame: the frame budget the styling rules measure against. */
const LATE_MS = 25;
/**
 * A height glide drawn a frame at a time, in whole pixels, on the fold's clock and curve. Its clock moves on by the
 * frames it's drawn in, a late one counting as LATE_MS at most, and its layers' fades go on the same clock: iOS can
 * take a while to paint what a fold has just put in, and on the wall's clock the next frame drew the rest of the
 * glide at once.
 */
function wholeGlide(box: HTMLElement, from: number, to: number, opening: boolean, fades: Animation[]): Room {
  const ms = opening ? OPEN_MS : CLOSE_MS;
  const ease = bezier(opening ? OPEN_CURVE : CLOSE_CURVE);
  for (const a of fades) a.pause();
  let at = 0;
  let last = performance.now();
  let raf = 0;
  let stop!: () => void;
  const finished = new Promise<void>((done) => {
    stop = done;
    const draw = (now: number) => {
      at += Math.max(0, Math.min(LATE_MS, now - last));
      last = now;
      for (const a of fades) a.currentTime = Math.min(at, ms);
      const p = Math.min(1, at / ms);
      const h = from + (to - from) * ease(p);
      box.style.height = `${p <= 0 || p >= 1 ? h : to > from ? Math.max(from, Math.floor(h)) : Math.min(from, Math.ceil(h))}px`;
      if (p < 1) raf = requestAnimationFrame(draw);
      else done();
    };
    draw(last);
  });
  return {
    cancel: () => {
      cancelAnimationFrame(raf);
      stop();
    },
    finished,
  };
}

/** Ends a page glide once its room has glided, its fades with it, leaving its resting styles (`rest`). */
function settle(room: Animation | Room, anims: Animation[], rest: () => void): FoldGlide {
  let ended = false;
  let done!: () => void;
  const finished = new Promise<void>((res) => (done = res));
  const end = () => {
    if (ended) return;
    ended = true;
    rest();
    room.cancel();
    for (const a of anims) a.cancel();
    done();
  };
  void room.finished.then(end, () => undefined);
  return { end, finished };
}
