// Every popup closes the same easy, smooth way (Daniel, 2026-10-21, cardinal rule: "All popup modals must have this
// in common"; his picks "Every popup, Mac and phone" and "Bottom sheets, pull to close"), a port of Forge's
// scripts/check-popups.mjs. Run by `npm run typecheck`. One shared popup draws them all: components/ui/dialog.tsx
// and alert-dialog.tsx (Base UI's Dialog: its X, a tap outside and Esc close it; on a phone a sheet from the bottom,
// `.ls-pop`, whose grabber closes it and which pulls shut from anywhere, src/lib/ui/sheet-pull.ts through
// use-sheet-pull.ts, riding the keyboard through sheet-keyboard.ts; every way out leaves the way it came, Base UI's
// data-ending-style). The phone's drawer (the sidebar) is the one other layer: Esc, a tap on its dim and a pull to
// the left close it, on the sheets' curve. This fails:
// - a dim or dialog drawn elsewhere: a tag with `fixed` and `inset-0`, or role="dialog" / "alertdialog", outside the
//   two popup files, unless NOT_POPUPS says what it is;
// - a hand-drawn dropdown (an `absolute` box with `shadow-pop`) that isn't a <Grown>, so it pops instead of growing out
//   of what was pressed;
// - a grabber that's only a drawing (`ls-grabber` not on a DialogPrimitive.Close or a button with onClick);
// - the popups, the pull or the drawer losing a way out or its feel.
import { attr, attrNames, classesOf, parse, read, tagName, tagOf, textOf, tsxFiles, utility, at, ts } from './lib.mjs'

/** Layers that aren't popups, by their first class: what each is instead. */
const NOT_POPUPS = {
  'ls-drawer-dim': "Sidebar: the phone's drawer dim, always mounted and faded by class, so it never pops (Esc, a tap and a pull close the drawer)",
  'ls-veil': 'LoadingVeil: the veil over a page as it changes, not a popup'
}
const POPUP_FILES = ['/components/ui/dialog.tsx', '/components/ui/alert-dialog.tsx']

const drawnElsewhere = []
const popMenus = []
const deadGrabs = []
for (const file of tsxFiles()) {
  const own = POPUP_FILES.some((p) => file.endsWith(p))
  const { sf } = parse(file)
  const visit = (node) => {
    const tag = tagOf(node)
    if (tag) {
      const name = tagName(tag, sf)
      const classes = classesOf(tag, sf)
      const u = classes.map(utility)
      const role = textOf(attr(tag, 'role')?.initializer)
      const layer = u.includes('fixed') && u.includes('inset-0')
      if (!own && (layer || role === 'dialog' || role === 'alertdialog') && !NOT_POPUPS[classes[0]]) drawnElsewhere.push(`${at(file, sf, tag)} (${classes[0] ?? name})`)
      if (u.includes('absolute') && u.includes('shadow-pop') && name !== 'Grown') popMenus.push(`${at(file, sf, tag)} (${name})`)
      if (classes.includes('ls-grabber') && !(name === 'DialogPrimitive.Close' || (name === 'button' && attr(tag, 'onClick')))) deadGrabs.push(`${at(file, sf, tag)} (${name})`)
      if (/^(Sheet|Drawer)(Content|Root)?$/.test(name)) drawnElsewhere.push(`${at(file, sf, tag)} (${name}: a second popup kind)`)
      void attrNames
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
const dialog = read('src/components/ui/dialog.tsx')
const alert = read('src/components/ui/alert-dialog.tsx')
const pull = read('src/lib/ui/sheet-pull.ts')
const usePull = read('src/lib/ui/use-sheet-pull.ts')
const sidebar = read('src/components/layout/sidebar.tsx')
const css = read('src/app/globals.css')
const lost = [
  [/<DialogPrimitive\.Backdrop/.test(dialog) && /<DialogPrimitive\.Backdrop/.test(alert), 'a tap or click outside it (the Backdrop, Dialog and AlertDialog)'],
  [/<XIcon/.test(dialog), "the Dialog's X"],
  [/className="ls-grabber"/.test(dialog) && /className="ls-grabber"/.test(alert) && /ref=\{grabber\}/.test(dialog) && /ref=\{grabber\}/.test(alert), 'its grabber: a tap closes it (DialogPrimitive.Close as ls-grabber, in both)'],
  [/useSheetPull\(dim, grabber\)/.test(dialog) && /useSheetPull\(dim, grabber\)/.test(alert) && /pullToClose\(/.test(usePull), 'the pull down on the phone (pullToClose through useSheetPull, in both)'],
  [/const FLICK = 0\.5;/.test(pull) && /const FLICK_MIN = 12;/.test(pull) && /dy > size \/ 3 \|\| \(speed > FLICK && dy > FLICK_MIN\)/.test(pull), "the pull's feel: past a third of its size, or a flick (src/lib/ui/sheet-pull.ts)"],
  [/sheetKeyboard\(el,/.test(usePull), 'riding the keyboard on the phone (sheetKeyboard through useSheetPull)'],
  [/\.ls-pop\b/.test(css) && /data-ending-style/.test(css) && /data-starting-style/.test(css), 'leaving the way it came (.ls-pop with Base UI starting and ending styles in globals.css)'],
  [/e\.key !== "Escape"/.test(sidebar) && /pullToClose\(el,/.test(sidebar) && /axis: "-x"/.test(sidebar) && /className=\{cn\("ls-drawer-dim lg:hidden", open && "is-open"\)\}/.test(sidebar), "the phone's drawer: Esc, a pull to the left, and an always-mounted dim (sidebar.tsx)"],
  [/\.ls-drawer-dim\s*\{[^}]*visibility 0s linear 420ms/.test(css) && /\.app-rail\.is-open\s*\{[^}]*visibility 0s/.test(css), "the drawer and its dim leaving on the sheets' curve, never in one frame (.ls-drawer-dim, .app-rail in globals.css)"]
]
  .filter(([ok]) => !ok)
  .map(([, what]) => what)
if (drawnElsewhere.length) console.error(`A popup not drawn by components/ui/dialog.tsx or alert-dialog.tsx, so it closes its own way (2026-10-21: "All popup modals must have this in common"). Draw it with <Dialog> or <AlertDialog>, or say in scripts/style/check-popups.mjs NOT_POPUPS what it is instead:\n${drawnElsewhere.map((m) => `  ${m}`).join('\n')}`)
if (popMenus.length) console.error(`A dropdown drawn by hand that pops in and out in one frame. Draw it as <Grown open={…} origin="top left"> (components/ui/grown.tsx):\n${popMenus.map((m) => `  ${m}`).join('\n')}`)
if (deadGrabs.length) console.error(`A grabber that does nothing: make it a DialogPrimitive.Close or a button that closes its sheet:\n${deadGrabs.map((m) => `  ${m}`).join('\n')}`)
if (lost.length) console.error(`The popups or the drawer lost a way out or their feel:\n${lost.map((m) => `  ${m}`).join('\n')}`)
if (drawnElsewhere.length || popMenus.length || deadGrabs.length || lost.length) process.exit(1)
console.log('check-popups: one shared popup draws them all, every dropdown grows out of what was pressed, every grabber works')
