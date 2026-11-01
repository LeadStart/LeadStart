"use client";

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { flushSync } from "react-dom";

/**
 * One steady press on a card, row or tile a finger taps on a phone (the "Cards on a phone" rule; a port of
 * Forge's lib/cardPress.ts). Once a finger has rested on the card for SETTLE_MS (so a swipe never lights one),
 * it takes the app's chosen look (`data-press`, globals.css `.ls-press`) and keeps that one look; a tap shows it
 * for TAP_MS as the card opens. A card with a hold menu (`onHold`) gives a little while the hold counts
 * (`scale`, never `transform`), and at HOLD_MS its menu goes in before the frame is drawn (flushSync), the
 * list held still under the finger until it lifts. A drift past HOLD_SLOP, a `touchcancel` or a `pointercancel`
 * puts the press out. iOS's own tap highlight is off on these cards (globals.css).
 * `scripts/style/check-card-press.mjs` fails a tappable row or card pressed any other way.
 */
export const HOLD_MS = 450;
/** How long a finger rests on a card before it lights: past it, a press isn't the start of a swipe. */
export const SETTLE_MS = 90;
/** How far a finger may drift before the press is a scroll. */
export const HOLD_SLOP = 10;
/** How long a tapped card stays lit before it lets go. */
const TAP_MS = 140;

type Press = { card: HTMLElement; x: number; y: number; settle?: number; hold?: number; fired: boolean };

export interface CardPressHandlers {
  onTouchStart: (e: ReactTouchEvent<HTMLElement>) => void;
  onTouchMove: (e: ReactTouchEvent<HTMLElement>) => void;
  onTouchEnd: (e: ReactTouchEvent<HTMLElement>) => void;
  onTouchCancel: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
}

export interface CardPress {
  /** The handlers a card spreads: `onHold` opens its menu where the finger is; left out, a tap still shows its press. */
  (onHold?: (card: HTMLElement, at: { x: number; y: number }) => void): CardPressHandlers;
}

export function useCardPress(): CardPress {
  const press = useRef<Press | null>(null);
  const fired = useRef(false);
  const lock = useRef(false);

  const put = (card: HTMLElement, look?: "lit" | "count") => {
    if (look) card.dataset.press = look;
    else delete card.dataset.press;
  };
  const end = (keepLook = false) => {
    const p = press.current;
    if (!p) return;
    window.clearTimeout(p.settle);
    window.clearTimeout(p.hold);
    press.current = null;
    if (!keepLook) put(p.card);
  };

  useEffect(() => {
    const move = (e: TouchEvent) => {
      if (lock.current && e.cancelable) e.preventDefault();
    };
    const lift = (e: TouchEvent) => {
      if (!e.touches.length) lock.current = false;
    };
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", lift, true);
    document.addEventListener("touchcancel", lift, true);
    return () => {
      end();
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", lift, true);
      document.removeEventListener("touchcancel", lift, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (onHold) => ({
    onTouchStart: (e) => {
      const card = e.currentTarget;
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return end();
      end();
      fired.current = false;
      const p: Press = { card, x: t.clientX, y: t.clientY, fired: false };
      press.current = p;
      p.settle = window.setTimeout(() => {
        if (press.current !== p) return;
        put(card, "lit");
        if (onHold)
          requestAnimationFrame(() => {
            if (press.current === p && !p.fired) put(card, "count");
          });
      }, SETTLE_MS);
      if (!onHold) return;
      p.hold = window.setTimeout(() => {
        if (press.current !== p) return;
        p.fired = true;
        fired.current = true;
        lock.current = true;
        window.clearTimeout(p.settle);
        flushSync(() => onHold(card, { x: p.x, y: p.y }));
        press.current = null;
        put(card);
      }, HOLD_MS);
    },
    onTouchMove: (e) => {
      const p = press.current;
      const t = e.touches[0];
      if (p && t && Math.hypot(t.clientX - p.x, t.clientY - p.y) > HOLD_SLOP) end();
    },
    onTouchEnd: (e) => {
      const p = press.current;
      if (p && !p.fired) {
        end(true);
        put(p.card, "lit");
        window.setTimeout(() => {
          if (press.current?.card !== p.card) put(p.card);
        }, TAP_MS);
      }
      if (fired.current && e.cancelable) e.preventDefault();
    },
    onTouchCancel: () => end(),
    onPointerCancel: () => end(),
    onClickCapture: (e) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  });
}
