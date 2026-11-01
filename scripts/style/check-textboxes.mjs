// No text box on the phone sits under the keyboard (Daniel, 2026-10-20: "the keyboard covered the entire textbox
// initially. We need to investigate and come up with a lasting fix"; his pick "every box, plus a check"), a port of
// Forge's scripts/check-textboxes.mjs. Run by `npm run typecheck`: every <textarea> and <Textarea> says how the phone
// keeps it above the keyboard, so a new one can't be added without choosing:
// - data-kb-reveal: partway down a page, the page's own script (src/lib/ui/keyboard-reveal.ts, mounted by
//   components/layout/keyboard-reveal.tsx in the root layout) brings it above the keyboard in its page's own scroller,
//   sized for the keyboard's last height, as it does every one-line field;
// - data-kb-sheet: inside a popup, whose sheet rides the keyboard (src/lib/ui/sheet-keyboard.ts through useSheetPull);
// - data-kb-dock: pinned at the foot of a screen (a chat's box), it rides the keyboard.
// And the page script keeps what makes it steady: a tap takes the cursor with preventScroll (iOS never slides the page),
// the screen holds still while you type (a non-passive touchmove that cancels a drag no scroller beside the box takes),
// the hold lets go whenever the box isn't fully in view (a guard never traps a bad layout), a growing box is kept above
// the keyboard from an input listener, and keyboard mode ends at blur in the same frame.
import { attrNames, parse, read, tagName, tagOf, tsxFiles, at, ts } from './lib.mjs'

const MARKS = ['data-kb-reveal', 'data-kb-sheet', 'data-kb-dock']
const missing = []
for (const file of tsxFiles()) {
  if (file.endsWith('/components/ui/textarea.tsx')) continue
  const { sf } = parse(file)
  const visit = (node) => {
    const tag = tagOf(node)
    if (tag && /^(textarea|Textarea)$/.test(tagName(tag, sf)) && !attrNames(tag).some((n) => MARKS.includes(n))) missing.push(at(file, sf, tag))
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

const reveal = read('src/lib/ui/keyboard-reveal.ts')
const layout = read('src/app/layout.tsx')
const mount = read('src/components/layout/keyboard-reveal.tsx')
const pull = read('src/lib/ui/use-sheet-pull.ts')
const dialog = read('src/components/ui/dialog.tsx')
const alert = read('src/components/ui/alert-dialog.tsx')
const lost = [
  [/window\.addEventListener\("touchmove", onTouchMove, \{ capture: true, passive: false \}\)/.test(reveal) && /e\.preventDefault\(\);\s*\};\s*const onTouchEnd/.test(reveal), 'its hold-still (a non-passive touchmove listener that cancels a drag no scroller beside the box takes)'],
  [/if \(r\.top < 0 \|\| r\.bottom > foot\(height\) \+ 0\.5\) return;/.test(reveal), "letting go whenever the box isn't fully in view (a guard never traps a bad layout)"],
  [(reveal.match(/focus\(\{ preventScroll: true \}\)/g) ?? []).length >= 2, 'a tap taking the cursor with preventScroll, so iOS never slides the page to the box'],
  [/window\.addEventListener\("input", onInput\)/.test(reveal), 'a growing box kept above the keyboard from an input listener (before iOS scrolls the page to the cursor)'],
  [/document\.addEventListener\("focusin", onFocusIn\)/.test(reveal) && /focusout/.test(reveal), 'keyboard mode starting at focus and ending at blur in the same frame'],
  [/visualViewport/.test(reveal), "meeting the keyboard's reported height (visualViewport)"],
  [/keyboardReveal\(\)/.test(mount) && /<KeyboardReveal \/>/.test(layout), 'the page script mounted in the root layout (KeyboardReveal in src/app/layout.tsx)'],
  [/sheetKeyboard\(el,/.test(pull) && /useSheetPull\(dim, grabber\)/.test(dialog) && /useSheetPull\(dim, grabber\)/.test(alert), "a popup's sheet riding the keyboard (sheetKeyboard through useSheetPull in dialog.tsx and alert-dialog.tsx)"]
]
  .filter(([ok]) => !ok)
  .map(([, what]) => what)
if (lost.length) console.error(`The phone's keyboard handling lost what keeps it steady (src/lib/ui/keyboard-reveal.ts):\n${lost.map((l) => `  ${l}`).join('\n')}`)
if (missing.length) console.error(`A text box that doesn't say how the phone keeps it above the keyboard (2026-10-20). Mark the <textarea> data-kb-reveal (partway down a page), data-kb-sheet (inside a popup) or data-kb-dock (pinned at a screen's foot):\n${missing.map((m) => `  ${m}`).join('\n')}`)
if (lost.length || missing.length) process.exit(1)
console.log('check-textboxes: every text box says how the phone keeps it above the keyboard, and the page script keeps its hold')
