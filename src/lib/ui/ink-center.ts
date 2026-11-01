/**
 * Lone labels sit on their ink (the icons rule, Daniel, 2026-10-28: "Icons plus badges").
 *
 * A count, an initial or a symbol alone in a pill, ring, badge or avatar is centred by what it
 * draws, not by its box. Poppins' side bearings and descender tails (Q, J) put a run's ink up
 * to 0.6px off its run box, and no CSS centres a run better than the font's metrics. So every
 * `<Ink>` span (components/ui/ink.tsx) is measured in a canvas with its own font
 * (actualBoundingBox, the same reading as scripts/style/measure-icon-centers.js) and slid with
 * `translate` until its ink's middle lands on its holder's middle, inside the holder's borders.
 * Nothing changes size, and nothing around it moves.
 *
 * A span joins the pass from its component's layout effect, once React has mounted it, never from
 * a watch over the DOM: a `translate` written on server HTML before React hydrated it made React 19
 * report an attribute mismatch on every inbox row (2026-10-31). One pass per frame over the spans
 * registered: reset, read, then write, so layout runs twice at most. It runs again when a span
 * re-renders, when its holder changes size (a ResizeObserver), on window resize and once fonts
 * have loaded.
 */

type Box = { x0: number; x1: number; y0: number; y1: number };

let ctx: CanvasRenderingContext2D | null = null;
const last = new WeakMap<HTMLElement, string>();
/** The spans mounted now. */
const live = new Set<HTMLElement>();
let holders: ResizeObserver | null = null;
let frame = 0;
let listening = false;

function inkOf(el: HTMLElement, text: string): Box | null {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent?.trim());
  if (!node) return null;
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const tt = cs.textTransform;
  const drawn =
    tt === "uppercase" ? text.toUpperCase() : tt === "lowercase" ? text.toLowerCase() : text;
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
  const m = ctx.measureText(drawn);
  // Where the run starts: the range over the text itself, past any leading whitespace.
  const raw = node.textContent ?? "";
  const lead = raw.indexOf(text);
  const range = document.createRange();
  range.setStart(node, Math.max(0, lead));
  range.setEnd(node, Math.max(0, lead) + text.length);
  const left = range.getBoundingClientRect().left;
  // The baseline: a zero-size inline-block sits on it.
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0";
  el.insertBefore(probe, node);
  const base = probe.getBoundingClientRect().bottom;
  probe.remove();
  return {
    x0: left - m.actualBoundingBoxLeft,
    x1: left + m.actualBoundingBoxRight,
    y0: base - m.actualBoundingBoxAscent,
    y1: base + m.actualBoundingBoxDescent,
  };
}

/** One pass over the spans given (every mounted `<Ink>` by default): reset, read, then write. */
export function inkCenterPass(els: Iterable<HTMLElement> = live): number {
  const todo: { el: HTMLElement; text: string; key: string }[] = [];
  for (const el of els) {
    if (!el.isConnected) {
      live.delete(el);
      continue;
    }
    const holder = el.parentElement;
    const text = (el.textContent ?? "").trim();
    if (!holder || !text) {
      el.style.translate = "";
      last.delete(el);
      continue;
    }
    const hr = holder.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const key = `${text}|${cs.font}|${cs.letterSpacing}|${cs.textTransform}|${Math.round(hr.width * 4)}x${Math.round(hr.height * 4)}`;
    if (last.get(el) === key) continue;
    todo.push({ el, text, key });
  }
  if (!todo.length) return 0;
  for (const t of todo) t.el.style.translate = "";
  const writes: { el: HTMLElement; value: string; key: string }[] = [];
  for (const { el, text, key } of todo) {
    const holder = el.parentElement as HTMLElement;
    const ink = inkOf(el, text);
    if (!ink) continue;
    const r = holder.getBoundingClientRect();
    const hs = getComputedStyle(holder);
    const bl = parseFloat(hs.borderLeftWidth), br = parseFloat(hs.borderRightWidth);
    const bt = parseFloat(hs.borderTopWidth), bb = parseFloat(hs.borderBottomWidth);
    const cx = r.left + bl + (r.width - bl - br) / 2;
    const cy = r.top + bt + (r.height - bt - bb) / 2;
    const dx = cx - (ink.x0 + ink.x1) / 2;
    const dy = cy - (ink.y0 + ink.y1) / 2;
    const value = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 ? "" : `${dx.toFixed(2)}px ${dy.toFixed(2)}px`;
    writes.push({ el, value, key });
  }
  for (const w of writes) {
    w.el.style.translate = w.value;
    last.set(w.el, w.key);
  }
  return writes.length;
}

/** A pass in the next frame (one however many ask). */
export function inkSchedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    inkCenterPass();
  });
}

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("resize", inkSchedule);
  const fonts = document.fonts;
  fonts?.ready.then(inkSchedule);
  fonts?.addEventListener?.("loadingdone", inkSchedule);
  if ("ResizeObserver" in window) holders = new ResizeObserver(inkSchedule);
}

/** An `<Ink>` span React has mounted (or re-rendered): measured in the next frame, and again whenever its holder resizes. */
export function inkRegister(el: HTMLElement): void {
  listen();
  live.add(el);
  last.delete(el);
  if (el.parentElement) holders?.observe(el.parentElement);
  inkSchedule();
}

/** The span is leaving (or about to re-render): its slide goes, and its holder's watch once no span of it is left. */
export function inkRelease(el: HTMLElement): void {
  live.delete(el);
  last.delete(el);
  el.style.translate = "";
  const holder = el.parentElement;
  if (!holder || !holders) return;
  for (const o of live) if (o.parentElement === holder) return;
  holders.unobserve(holder);
}
