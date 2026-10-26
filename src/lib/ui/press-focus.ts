/** Keys that only change the next one: on their own they do nothing, so they're not moving around by keyboard. */
const ONLY_MODIFY = new Set(["Shift", "CapsLock", "Control", "Alt", "AltGraph", "Meta", "Fn", "FnLock"]);

/**
 * Shift never selects what you last pressed (cardinal rule; a port of Forge's
 * lib/pressFocus.ts). Chromium takes any key, Shift and Caps Lock included, as
 * moving around by keyboard, and rings whatever has focus: press a button, hold
 * Shift for a capital, and the button lit up. A press (mouse, trackpad or finger)
 * marks the page `data-focus="press"`, which keeps those rings off (globals.css);
 * the first key that does something on its own (Tab, an arrow, Return, a letter)
 * brings them back. Text fields keep their own look.
 */
export function quietPressRings(): () => void {
  const root = document.documentElement;
  const press = () => {
    root.dataset.focus = "press";
  };
  const key = (e: KeyboardEvent) => {
    if (!ONLY_MODIFY.has(e.key)) delete root.dataset.focus;
  };
  addEventListener("pointerdown", press, true);
  addEventListener("keydown", key, true);
  return () => {
    removeEventListener("pointerdown", press, true);
    removeEventListener("keydown", key, true);
  };
}
