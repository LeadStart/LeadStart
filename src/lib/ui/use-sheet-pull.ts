"use client";

import { useCallback, useRef, type RefObject } from "react";
import { pullToClose } from "@/lib/ui/sheet-pull";
import { keyboardUp, sheetKeyboard, touch } from "@/lib/ui/sheet-keyboard";

/** Phones: where a popup is a sheet from the bottom (globals.css `.ls-pop`). */
const PHONE = "(max-width: 639.98px)";
/** The curve every sheet rises and falls on (iOS's own, Forge's Modal), and how long each way takes. */
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const RISE_MS = 520;
const FALL_MS = 420;

/**
 * A popup's sheet pulls shut on a phone (cardinal rule: every popup closes the same
 * easy, smooth way). Returns the Base UI Popup's callback ref and its `initialFocus`.
 * `dim` is its Backdrop and `closer` a Close button inside it (the grabber): pulled past a third
 * of its height or flicked down, the sheet slides on from where the finger left it
 * to past the screen's foot as the dim fades, and the closer's click hands the close
 * to Base UI, which waits for that slide before taking it off the page. A short pull
 * springs back. An owner that keeps it open after all gets it back up. While a box in
 * it has the cursor it stands on the keyboard, and closed then it goes after the
 * keyboard (sheet-keyboard.ts).
 */
export function useSheetPull(
  dim: RefObject<HTMLElement | null>,
  closer: RefObject<HTMLElement | null>,
) {
  const off = useRef<(() => void) | null>(null);
  const node = useRef<HTMLElement | null>(null);

  const ref = useCallback(
    (el: HTMLElement | null) => {
      off.current?.();
      off.current = null;
      node.current = el;
      if (!el) return;
      const phone = window.matchMedia(PHONE);
      let base = 0;
      let unpull: (() => void) | null = null;
      let unkeys: (() => void) | null = null;

      const fade = (y: number) => {
        const d = dim.current;
        if (d) d.style.opacity = String(Math.max(0, 1 - Math.max(0, y) / Math.max(1, el.offsetHeight)));
      };
      const springBack = () => {
        el.style.transition = `transform ${RISE_MS}ms ${EASE}`;
        el.style.transform = "";
        const d = dim.current;
        if (d) {
          d.style.transition = `opacity ${RISE_MS}ms ${EASE}`;
          d.style.opacity = "";
        }
        window.setTimeout(() => {
          el.style.transition = "";
          if (d) d.style.transition = "";
        }, RISE_MS + 40);
      };
      const wire = () => {
        unpull?.();
        unkeys?.();
        unpull = unkeys = null;
        if (!phone.matches) return;
        unkeys = sheetKeyboard(el, () => dim.current);
        unpull = pullToClose(el, {
          can: () => !el.hasAttribute("data-ending-style"),
          begin: () => {
            // Taken mid-way up, it stays where it was under the finger.
            const t = getComputedStyle(el).transform;
            base = t && t !== "none" ? Math.max(0, new DOMMatrix(t).m42) : 0;
            el.style.transition = "none";
            el.style.transform = `translateY(${base}px)`;
            const d = dim.current;
            if (d) d.style.transition = "none";
            fade(base);
          },
          move: (dy) => {
            const y = base + dy;
            el.style.transform = `translateY(${y}px)`;
            fade(y);
          },
          end: (close) => {
            if (!close) return springBack();
            // On the keyboard, its way out starts where the finger left it, after the
            // keyboard (sheet-keyboard.ts); otherwise it slides on from here.
            if (!keyboardUp(el)) {
              el.style.transition = `transform ${FALL_MS}ms ${EASE}`;
              el.style.transform = "translateY(100%)";
              const d = dim.current;
              if (d) {
                d.style.transition = `opacity ${FALL_MS}ms ${EASE}`;
                d.style.opacity = "0";
              }
            }
            closer.current?.click();
            // Kept open by its owner after all: back up.
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                if (el.isConnected && !el.hasAttribute("data-ending-style")) springBack();
              }),
            );
          },
        });
      };
      wire();
      phone.addEventListener("change", wire);
      off.current = () => {
        unpull?.();
        unkeys?.();
        phone.removeEventListener("change", wire);
      };
    },
    [dim, closer],
  );

  /**
   * On a touch screen it opens with the cursor on itself, never in a box no finger
   * tapped: iOS brings no keyboard for that, so the box would sit lit with none. Base
   * UI does the same for a popup a touch opened, but most of LeadStart's are opened
   * by their own buttons, which it can't see.
   */
  const initialFocus = useCallback(
    (type: string) => (type === "touch" || touch() ? node.current : true),
    [],
  );

  return [ref, initialFocus] as const;
}
