/**
 * A phone sheet and the keyboard (components/ui/dialog.tsx, alert-dialog.tsx, through
 * use-sheet-pull.ts). The popup cardinal rule: a sheet with a text box rides the
 * keyboard without jumping, and closed with the keyboard up it goes after the
 * keyboard. A port of Forge's useSheetKeyboard, its Modal's way out
 * (src/renderer/src/components/Modal.tsx) and lib/kbMotion.ts, made for Safari:
 * Forge's phone script resizes its whole app for the keyboard, but in Safari the page
 * keeps its height and the keyboard covers its foot, so the sheet reads the keyboard's
 * room from `visualViewport` and stands on it.
 */

/** Up over 240ms on CSS ease, down over 200ms, on iOS's keyboard's own clock. */
const UP = { duration: 240, easing: "ease" };
const DOWN = { duration: 200, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
/** How long iOS holds the page's drawing as the keyboard starts down (Forge's Modal):
 *  a sheet closed with the keyboard up waits that long before it slides. */
const KB_HOLD_MS = 140;
/** Less than this at the page's foot isn't a keyboard (Safari's own bars, a hardware keyboard's strip). */
const MIN_ROOM = 120;
/** The way out, as the stylesheet's phone sheet (globals.css `.ls-pop`). */
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const FALL_MS = 420;
/** Where each kind of keyboard's last height is kept, so the next one is met as it rises. */
const MEMORY = "ls-keyboard";

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A finger, not a mouse: only there does a box bring up a keyboard. */
export const touch = () => matchMedia("(hover: none) and (pointer: coarse)").matches;

const NOT_TYPED = /^(checkbox|radio|button|submit|reset|image|file|hidden|range|color|date|datetime-local|month|week|time)$/;
/** A box that brings up the keyboard. */
export function isTextField(t: EventTarget | null): t is HTMLElement {
  if (t instanceof HTMLTextAreaElement) return !t.readOnly && !t.disabled;
  if (t instanceof HTMLInputElement) return !NOT_TYPED.test(t.type) && !t.readOnly && !t.disabled;
  return t instanceof HTMLElement && t.isContentEditable;
}

/** When a box last let the cursor go, so the keyboard started down. */
let wentAt: number | undefined;
let watching = false;
function watchCursor() {
  if (watching) return;
  watching = true;
  window.addEventListener(
    "focusout",
    (e) => {
      if (isTextField(e.target) && !isTextField(e.relatedTarget)) wentAt = performance.now();
    },
    true,
  );
}

/** Which keyboard a box brings up, held which way: each has its own height (an email
 *  box's has no suggestions row, a phone box's is a number pad). */
function kindOf(f: HTMLElement) {
  const type = f instanceof HTMLInputElement ? f.type : "";
  const mode = f.inputMode;
  const keys =
    type === "tel" || /^(numeric|decimal|tel)$/.test(mode)
      ? "pad"
      : type === "email" || type === "url" || /^(email|url)$/.test(mode)
        ? "plain"
        : "letters";
  return `${innerWidth > innerHeight ? "side" : "up"}:${keys}`;
}
function recall(kind: string): number {
  try {
    return Number(JSON.parse(localStorage.getItem(MEMORY) || "{}")[kind]) || 0;
  } catch {
    return 0;
  }
}
function remember(kind: string, height: number) {
  try {
    const all = JSON.parse(localStorage.getItem(MEMORY) || "{}");
    if (Math.round(all[kind]) === Math.round(height)) return;
    all[kind] = Math.round(height);
    localStorage.setItem(MEMORY, JSON.stringify(all));
  } catch {
    /* private mode: met as Safari reports it instead */
  }
}

/** The keyboard's height as Safari reports it: what of the page (which keeps its height) the visible area no longer shows. */
function reportedHeight(): number {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return 0;
  const h = document.documentElement.clientHeight - vv.height;
  return h >= MIN_ROOM ? h : 0;
}

/** The safe area's top, where the status bar or Dynamic Island is. */
function safeTop(): number {
  const p = document.createElement("div");
  p.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none";
  document.body.appendChild(p);
  const h = p.offsetHeight;
  p.remove();
  return h;
}

/** Puts the cursor at the end of a box's text (boxes for email and numbers have no caret to set). */
function caretToEnd(f: HTMLElement) {
  if (!(f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) return;
  try {
    f.setSelectionRange(f.value.length, f.value.length);
  } catch {
    /* email, number: iOS leaves it at the end */
  }
}

/** How far from a box iOS still counts a tap as on it (its own touch adjustment). */
const NEAR = 12;
/** The box a tap at (x, y) is for: the one under it, its label's, or the nearest within reach, as iOS picks. */
function boxAt(sheet: HTMLElement, on: Element, x: number, y: number): HTMLElement | null {
  const own = on.closest?.("input, textarea, [contenteditable]") ?? on.closest?.("label")?.control ?? null;
  if (own) return isTextField(own) && sheet.contains(own) ? own : null;
  let best: HTMLElement | null = null;
  let near = NEAR;
  sheet.querySelectorAll<HTMLElement>("input, textarea, [contenteditable]").forEach((f) => {
    if (!isTextField(f)) return;
    const r = f.getBoundingClientRect();
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (d <= near) [best, near] = [f, d];
  });
  return best;
}

/** The box a field scrolls in, inside the sheet (the sheet itself if nothing nearer). */
function scrollerOf(field: HTMLElement, sheet: HTMLElement): HTMLElement {
  for (let n = field.parentElement; n && n !== sheet; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
  }
  return sheet;
}

/**
 * Motion that goes with the keyboard (Forge's lib/kbMotion.ts). iOS holds the page's
 * drawing for about 140 to 170ms as the keyboard comes or goes, and starts the
 * keyboard with the first frame it draws after that, so an animation started at the
 * tap ran most of its way unseen and jumped. Held at its start, it plays on the second
 * frame, and again from 40ms in on the first frame drawn after a hold in drawing (a
 * gap over 50ms) within its first 400ms: then it moves with the keyboard.
 */
function withKeyboard(a: Animation) {
  a.pause();
  const begin = performance.now();
  let frames = 0;
  let last = begin;
  let again = false;
  const tick = (t: number) => {
    if (++frames === 2) {
      if (a.playState !== "idle") a.play();
    } else if (frames > 2 && !again && t - last > 50 && t - begin < 400) {
      again = true;
      if (a.playState === "running" || a.playState === "paused") a.currentTime = 40;
    }
    last = t;
    if (t - begin < 600) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Wires a phone sheet to the keyboard; returns its unwiring. While a box in it has the
 * cursor, the sheet stands on the keyboard: sized for that keyboard's last height the
 * moment the box has the cursor, corrected when Safari reports it, its foot and height
 * gliding together on the keyboard's clock, and the box brought into view in its own
 * scroller as it goes. Closed with the keyboard up, it keeps its place on the screen,
 * waits out iOS's hold in drawing, then slides from there past the screen's foot.
 */
export function sheetKeyboard(sheet: HTMLElement, dim: () => HTMLElement | null): () => void {
  watchCursor();
  const vv = window.visualViewport;
  /** The keyboard's height it stands on now (0: the page's foot). */
  let height = 0;
  /** The tallest the keyboard has been since it came (iOS sometimes reports one without its form bar). */
  let peak = 0;
  let kind = "";
  let field: HTMLElement | null = null;
  let glide: Animation | undefined;
  let glideEnds = 0;
  let follow = 0;
  let settle = 0;
  /** How far Safari had slid the visible area down the page when it last stood. */
  let pannedAt = 0;
  /** Fingers on the screen now: a slide of the page under one is theirs. */
  let fingers = 0;
  /** Slides put back for this box: if iOS keeps sliding it again, it's let be (and met). */
  let undos = 0;
  /** When it last stood down from the keyboard. */
  let downAt = -Infinity;
  let leaving = false;
  let tookOver = false;
  /** The box a finger tapped, as it takes the cursor: only then is a keyboard coming. */
  let tapped: HTMLElement | null = null;
  /** A box taking the cursor again (the keyboard's arrows): its blur and focus aren't news. */
  let refocusing = false;

  /** The home bar's room in its padding: behind the keyboard while it's up. */
  const homeBar = () => Math.max(0, parseFloat(getComputedStyle(sheet).paddingBottom) - 20);

  /**
   * Stands it on `next` px of keyboard, gliding from where it is (`"clock"`: on the
   * keyboard's own clock, up or down; null: at once); `f` is brought into view as it goes.
   */
  const stand = (
    next: number,
    how: "clock" | KeyframeAnimationOptions | null,
    f: HTMLElement | null,
    slidBy = vv?.offsetTop ?? 0,
  ) => {
    const cs = getComputedStyle(sheet);
    const from = { bottom: parseFloat(cs.bottom) || 0, height: sheet.offsetHeight };
    const scroller = f ? scrollerOf(f, sheet) : null;
    const scrollFrom = scroller?.scrollTop ?? 0;
    glide?.cancel();
    glide = undefined;
    cancelAnimationFrame(follow);
    if (height && !next) downAt = performance.now();
    height = next;
    const panned = next ? slidBy : 0;
    pannedAt = panned;
    const lift = next ? Math.max(0, next - panned - homeBar()) : 0;
    sheet.style.bottom = lift ? `${lift}px` : "";
    sheet.style.maxHeight = "";
    if (lift) {
      // Never past the safe area's top, in the visible part of the page.
      const room = document.documentElement.clientHeight - lift - panned - safeTop() - 24;
      const own = parseFloat(getComputedStyle(sheet).maxHeight);
      sheet.style.maxHeight = `${Math.max(160, Math.min(Number.isFinite(own) ? own : room, room))}px`;
    }
    const to = { bottom: lift, height: sheet.offsetHeight };
    // The box sits about 16px above the keyboard in its own scroller.
    let scrollTo = scrollFrom;
    if (f && scroller && lift) {
      const fr = f.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const shown = Math.min(sr.bottom, sheet.getBoundingClientRect().bottom - homeBar() - 20);
      const below = fr.bottom + 16 - shown;
      const above = sr.top + 8 - fr.top;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (below > 0) scrollTo = Math.min(max, scrollFrom + below);
      else if (above > 0) scrollTo = Math.max(0, scrollFrom - above);
    }
    const moves = Math.abs(to.bottom - from.bottom) >= 2 || Math.abs(to.height - from.height) >= 2;
    if (!how || still() || !moves) {
      if (scroller) scroller.scrollTop = scrollTo;
      return;
    }
    const timing = how === "clock" ? (to.bottom > from.bottom ? UP : DOWN) : how;
    // Going down, its foot goes to the page's foot at once, behind the keyboard, and only
    // its top glides: gliding its foot, it trailed the falling keyboard by two or three
    // frames and the dim showed between them (iOS 27 simulator).
    const down = !next && from.bottom > 0;
    const a = sheet.animate(
      [
        down
          ? { bottom: "0px", height: `${from.bottom + from.height}px`, maxHeight: "none" }
          : { bottom: `${from.bottom}px`, height: `${from.height}px`, maxHeight: "none" },
        { bottom: `${to.bottom}px`, height: `${to.height}px`, maxHeight: "none" },
      ],
      { ...timing, fill: "backwards" },
    );
    glide = a;
    glideEnds = performance.now() + Number(timing.duration);
    a.onfinish = a.oncancel = () => {
      if (glide === a) glide = undefined;
    };
    if (scroller && scrollTo !== scrollFrom) {
      const step = () => {
        const done = a.playState === "finished" || a.playState === "idle";
        const p = done ? 1 : (a.effect?.getComputedTiming().progress ?? 0);
        scroller.scrollTop = scrollFrom + (scrollTo - scrollFrom) * p;
        if (!done) follow = requestAnimationFrame(step);
      };
      follow = requestAnimationFrame(step);
    }
    return a;
  };

  /**
   * Safari's word on the keyboard: met where the guess was off, and kept for next time.
   * While a box keeps the cursor it holds the tallest keyboard it was told of (iOS
   * sometimes reports one without its form bar for a moment); `settled`, once the
   * keyboard has had time to come, it takes what Safari says now.
   */
  const report = (settled = false) => {
    if (leaving || !field) return;
    const h = reportedHeight();
    if (!h) {
      // No keyboard after all (a hardware keyboard), or it went with the box keeping the
      // cursor: back down. Not while it's still on its way up.
      if (height && (settled || peak)) {
        peak = 0;
        stand(0, "clock", null);
      }
      return;
    }
    peak = settled ? h : Math.max(peak, h);
    remember(kind, peak);
    // iOS slid the page to bring a box to the middle: put back at once, as Forge's phone
    // script does. Left slid, it slid back as the keyboard went and took the sheet with
    // it, and iOS can take taps in the wrong place on a page slid like that (WebKit bug
    // 254861). Safari reads the slide back a frame later, so it stands as unslid now and
    // checks then.
    let at = vv?.offsetTop ?? 0;
    if (vv && (at > 0 || window.scrollY > 0) && !fingers && undos < 4) {
      undos++;
      window.scrollTo(0, 0);
      at = 0;
      requestAnimationFrame(() => report());
    }
    const slid = Math.abs(at - pannedAt) >= 2;
    if (peak === height && !slid) return;
    // A slide iOS keeps (under a finger) moves everything fixed with it in one step: met
    // in the same frame, the sheet stays where it was on the screen.
    if (peak === height && !glide) return void stand(peak, null, null, at);
    // Mid-glide, it keeps the glide's end; otherwise it goes on the keyboard's clock.
    const left = glide ? glideEnds - performance.now() : 0;
    stand(peak, left > 60 ? { duration: left, easing: "ease-out" } : "clock", field, at);
  };

  const onFocusIn = (e: FocusEvent) => {
    const f = e.target;
    if (refocusing || leaving || !touch() || !isTextField(f) || !sheet.contains(f)) return;
    // The keyboard's arrows move the cursor without a tap: taken again with
    // preventScroll, so iOS doesn't slide the page to bring the box to the middle.
    if (height && f !== tapped) {
      refocusing = true;
      f.blur();
      f.focus({ preventScroll: true });
      refocusing = false;
    }
    const was = kind;
    field = f;
    kind = kindOf(f);
    // A new box's keyboard can be another height: Safari's next word on it counts afresh.
    peak = 0;
    undos = 0;
    window.clearTimeout(settle);
    // Safari reports the keyboard once it's up; if it never does, there's none.
    settle = window.setTimeout(() => report(true), 700);
    if (height && kind === was) {
      // Box to box on the same keyboard: only the box's place in its scroller.
      stand(height, null, f);
      return;
    }
    // Only a box a finger tapped brings a keyboard: one given the cursor by code has none.
    const guess = f === tapped ? recall(kind) : 0;
    if (guess) {
      const a = stand(guess, "clock", f);
      if (a) withKeyboard(a);
    }
  };

  const onFocusOut = (e: FocusEvent) => {
    if (refocusing) return;
    if (leaving || !isTextField(e.target) || !sheet.contains(e.target as Node)) return;
    if (isTextField(e.relatedTarget)) return;
    field = null;
    kind = "";
    peak = 0;
    window.clearTimeout(settle);
    if (!height) return;
    // Down with the keyboard, timed from the moment the box let the cursor go.
    const a = stand(0, "clock", null);
    if (a) withKeyboard(a);
  };

  // A tap on a box: the box takes the cursor from here, with preventScroll. Left to
  // iOS, it slid the whole page up to show the box (162px in one frame, on the iOS 27
  // simulator) while the sheet rose to meet the keyboard, then the sheet glided back.
  // A press held (selecting, the loupe) or a drag stays iOS's.
  // A box that has the cursor with no keyboard up (put there by code) is taken the
  // same way, so its keyboard comes; with the keyboard up, a tap in the box with the
  // cursor moves the cursor, iOS's own.
  let press: { x: number; y: number; t: number; f: HTMLElement } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    press = null;
    const t = e.touches[0];
    if (leaving || !touch() || e.touches.length !== 1) return;
    // A box's label, or a tap just beside it, passes the tap to the box.
    const f = boxAt(sheet, e.target as Element, t.clientX, t.clientY);
    if (!f) return;
    if (f === document.activeElement && height) return;
    press = { x: t.clientX, y: t.clientY, t: e.timeStamp, f };
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (press && t && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) press = null;
  };
  const onTouchCancel = () => {
    press = null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const p = press;
    press = null;
    if (!p || e.timeStamp - p.t > 500 || !p.f.isConnected) return;
    e.preventDefault();
    tapped = p.f;
    if (document.activeElement === p.f) p.f.blur();
    p.f.focus({ preventScroll: true });
    tapped = null;
    caretToEnd(p.f);
  };

  /** Closed: with the keyboard up, it goes after the keyboard. */
  const leave = () => {
    leaving = true;
    window.clearTimeout(settle);
    const f = document.activeElement;
    if (isTextField(f) && sheet.contains(f)) f.blur();
    if (!height && performance.now() - downAt > 400) return; // no keyboard: the stylesheet's way out
    tookOver = true;
    const since = wentAt === undefined ? Infinity : performance.now() - wentAt;
    const wait = Math.max(0, Math.round(KB_HOLD_MS - since));
    const motion = still() ? "none" : `transform ${FALL_MS}ms ${EASE} ${wait}ms`;
    const d = dim();
    if (d) {
      d.style.transition = still() ? "none" : `opacity ${FALL_MS}ms ${EASE} ${wait}ms`;
      d.style.opacity = "0";
    }
    sheet.style.transition = motion;
    // It keeps the place it has on the screen (a pull's included) and slides from there.
    const cs = getComputedStyle(sheet);
    const bottom = parseFloat(cs.bottom) || 0;
    const tall = sheet.offsetHeight;
    const y = cs.transform && cs.transform !== "none" ? new DOMMatrixReadOnly(cs.transform).m42 : 0;
    glide?.cancel();
    glide = undefined;
    cancelAnimationFrame(follow);
    Object.assign(sheet.style, {
      bottom: `${bottom}px`,
      height: `${tall}px`,
      maxHeight: "none",
      transform: `translateY(${Math.max(y, 0)}px)`,
    });
    // The start is drawn as it stands; the slide goes from there.
    void sheet.offsetHeight;
    sheet.style.transform = `translateY(${Math.ceil(bottom + tall + 40)}px)`;
  };

  /** Opened again mid-way out: back up from where it is. */
  const back = () => {
    leaving = false;
    if (!tookOver) return;
    tookOver = false;
    height = 0;
    Object.assign(sheet.style, { bottom: "", height: "", maxHeight: "" });
    sheet.style.transition = `transform 520ms ${EASE}`;
    sheet.style.transform = "";
    const d = dim();
    if (d) {
      d.style.transition = `opacity 520ms ${EASE}`;
      d.style.opacity = "";
    }
    window.setTimeout(() => {
      sheet.style.transition = "";
      if (d) d.style.transition = "";
    }, 560);
  };

  const mo = new MutationObserver(() => {
    const ending = sheet.hasAttribute("data-ending-style");
    if (ending && !leaving) leave();
    else if (!ending && leaving) back();
  });
  mo.observe(sheet, { attributes: true, attributeFilter: ["data-ending-style"] });
  sheet.addEventListener("focusin", onFocusIn);
  sheet.addEventListener("focusout", onFocusOut);
  sheet.addEventListener("touchstart", onTouchStart, { passive: true });
  sheet.addEventListener("touchmove", onTouchMove, { passive: true });
  sheet.addEventListener("touchend", onTouchEnd, { passive: false });
  sheet.addEventListener("touchcancel", onTouchCancel, { passive: true });
  const onReport = () => report();
  const onFingers = (e: TouchEvent) => {
    fingers = e.touches.length;
    if (!fingers) report();
  };
  window.addEventListener("touchstart", onFingers, { capture: true, passive: true });
  window.addEventListener("touchend", onFingers, { capture: true, passive: true });
  window.addEventListener("touchcancel", onFingers, { capture: true, passive: true });
  vv?.addEventListener("resize", onReport);
  vv?.addEventListener("scroll", onReport);

  return () => {
    mo.disconnect();
    sheet.removeEventListener("focusin", onFocusIn);
    sheet.removeEventListener("focusout", onFocusOut);
    sheet.removeEventListener("touchstart", onTouchStart);
    sheet.removeEventListener("touchmove", onTouchMove);
    sheet.removeEventListener("touchend", onTouchEnd);
    sheet.removeEventListener("touchcancel", onTouchCancel);
    window.removeEventListener("touchstart", onFingers, { capture: true });
    window.removeEventListener("touchend", onFingers, { capture: true });
    window.removeEventListener("touchcancel", onFingers, { capture: true });
    vv?.removeEventListener("resize", onReport);
    vv?.removeEventListener("scroll", onReport);
    window.clearTimeout(settle);
    cancelAnimationFrame(follow);
    glide?.cancel();
    if (!leaving) Object.assign(sheet.style, { bottom: "", maxHeight: "" });
  };
}

/** Whether the sheet stands on the keyboard now (a pull lets its way out start here). */
export function keyboardUp(sheet: HTMLElement): boolean {
  return !!sheet.style.bottom && touch();
}

