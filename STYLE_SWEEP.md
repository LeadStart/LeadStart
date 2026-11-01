# Style sweep — LeadStart → Forge style, LeadStart colours (UI_RULES.md)

> Task #228 from LeadStart App's queue, swept 2026-10-26. Living ledger: coverage is proven here by measurement, not from memory. The flat-contract sweep of 2026-08-22 it replaces is summarised at the end.
> **STATUS: swept, and since 2026-10-31 held to Forge's sixteen rules by code (the pass at the end).** Tokens, shared parts and the shell are on the new contract; 44 pages measured at 1440, 1024, 390 and 375 with no sideways scroll and no touching or overlapping cards; the debt greps below are at their targets except the items listed under "Remaining".

## Evidence tiers used below
- **measured** = loaded in headless Chromium against the dev server (signed in through `/app/api/dev/login`, read-only), at 1440×900, 1024×768, 390×844 and 375×667 (the phone sizes as touch devices). Per page: `scrollWidth − clientWidth` of the document and of the shell's scroller is 0, and no two sibling cards touch or overlap. Plus a screenshot at each size, looked at by eye.
- **wraps** = every short label (card titles, buttons, chips, tabs, headings, table heads, labels) counted in lines per run of text, after fonts load, at 1440 and 390, and compared with the same pages on the unchanged branch (`master` at `98abf57`) run side by side. A label that wraps now but did not before fails.
- **popup** = frame log of the popup's position, opacity, scale and dim from `requestAnimationFrame`, for every way out: X, Esc, outside (desktop); X, outside, grabber, a pull past a third, a short pull, a flick at about 1.1 px/ms (phone). Pass = one-way motion, nothing left on the page, a short pull springs back. Frame timing was read on the production build (`next start`): on the phone every frame is 17ms or under for all nine ways out; on the computer, with the GPU on, the motion runs at 17ms, and only the frame of the press itself (before anything moves) sometimes takes 33ms. One run in twelve showed a single 167ms stall on Esc that nine more closes didn't repeat. Without a GPU (headless software drawing) the dim's 3px blur drops the computer's close to 30 frames a second; with the blur off it holds 17ms.
- **simulator** = the iOS 27 simulator (iPhone 18 Pro, Safari) with its real on-screen keyboard, the sheet's frames logged from the page and the screen recorded and stepped through at 33ms: a box tapped (the keyboard rising), box to box (taps, the keyboard's arrows, a shorter email keyboard), Done (the keyboard going), a box low in the sheet, and closing with the keyboard up by a pull, the grabber and the X. Pass = the sheet's top holds still, its foot rides the keyboard, iOS never slides the page, and a close slides off after the keyboard with nothing gone in one frame.
- **focus** = after clicking a field, `document.activeElement` is the field; holding Shift lights no ring on anything else; a capital typed lands in the field; Shift after pressing a button lights no ring; Tab still rings buttons and links.
- **code** = `npx tsc --noEmit` clean and the debt greps below.

## Phase 1 — tokens + shared parts
| surface | file(s) | status | evidence | notes |
|---|---|---|---|---|
| tokens, page bloom, sheens, shadows, motion | src/app/globals.css | verified | measured | `--background #f4f6fb` + blooms, `--border-soft`, `--tex-*`, `--ls-shadow-*`, `--radius 0.75rem` |
| press focus (Shift never rings) | src/lib/ui/press-focus.ts + globals.css | verified | focus | login, clients, overview, contacts: all pass; Tab rings intact |
| Card | ui/card.tsx | verified | measured | 16px, soft edge, `shadow-card`, `py-5`/`px-5` |
| Button (+ `.btn-gold` / `.btn-blue`) | ui/button.tsx, globals.css | verified | measured | pills, sheens, no shadow; `.btn-blue` rule restored (lost in `8e17502`) |
| Input / Textarea / `ls-select` / SelectTrigger | ui/input.tsx, ui/textarea.tsx, ui/select.tsx, globals.css | verified | measured + focus | 40px pill, 3px brand glow, 16px text on phones |
| Tabs (pill segmented + line) | ui/tabs.tsx, ui/underline-tab.tsx | verified | measured | tab rows scroll inside themselves on phones |
| Badge | ui/badge.tsx | verified | measured | solid `badge-*` fills kept |
| Menus (DropdownMenu, Select popup, `ls-menu`) | ui/dropdown-menu.tsx, ui/select.tsx, globals.css | verified | measured | grow in 220ms / out 160ms; in `@layer components` |
| Popups (Dialog, AlertDialog) | ui/dialog.tsx, ui/alert-dialog.tsx, lib/ui/sheet-pull.ts, use-sheet-pull.ts, sheet-keyboard.ts | verified | popup + simulator | Import CSV, Add mailbox wizard, flow step editor: every way out passes; Add Contact on the simulator with the keyboard: every case passes |
| Loading veil | layout/loading-veil.tsx, `.ls-veil` | verified | code + screenshot | sign-in and post-login loading |
| Table | ui/table.tsx | verified | measured | |

## Phase 2 — shell
| surface | file(s) | status | evidence | notes |
|---|---|---|---|---|
| Rail (brand row) | layout/sidebar.tsx, globals.css `.app-rail` | verified | measured | Daniel's pick at the checkpoint |
| Topbar | layout/topbar.tsx, `.app-topbar` | verified | measured | 52px |
| Phone tab bar (blue glass pill) | layout/mobile-tab-bar.tsx, `.ls-mnav*` | verified | measured | Daniel's pick at the checkpoint |
| Shell (page bloom shows through) | (dashboard)/dashboard-shell.tsx | verified | measured | |
| PageHeader, BackButton | layout/page-header.tsx, layout/back-button.tsx | verified | measured | |

## Phase 3 — pages
| area | pages | status | evidence |
|---|---|---|---|
| admin (30) | overview, clients, client detail, client campaign, campaigns, campaign detail, new email campaign, new LinkedIn campaign, contacts, feedback, inbox, inbox reply, LinkedIn to-dos, mailboxes, planner, prospecting, prospects, reports, reports preview, settings hub, integrations, billing, buyer experience, tags, tasks, team, tokens, settings workflows, workflows (flow map), onboarding preview | verified | measured + wraps |
| client portal (8, viewed as David Cabrera) | home, activity, feedback, inbox, reports, settings, campaign, inbox reply | verified | measured + wraps |
| sign-in and public (6) | login, signup, reset password, update password, accept invite, welcome (demo) | verified | measured + wraps |
| hosted quote page | quote/[id] | restyled | code; its `QuoteLayout` measured through the Onboarding preview, which renders the real one (not opened with a real token, to leave quote views alone); `test-onboarding-preview-sync.ts` 22/22 |
| buyer (3) | buyer, buyer contacts, buyer search | restyled | code only (buyer-only pages) |

Overlays moved onto the shared popup: `admin/mailboxes/add-mailbox-wizard.tsx` (popup), `campaigns/flow/flow-editor.tsx` step editor (popup; was a `createPortal` with its own Esc and scroll lock), `quote/[id]/accept-and-pay.tsx` (code: it needs a live Stripe session, so it was not opened). The sign-in and post-login loading screens have nothing to close, so they became `LoadingVeil` rather than popups.

Layout fixes made during the sweep, each measured before and after: the client detail page ran 257px off a phone before this work (its chart's grid column), now 0; the chart card's legend wraps under its title; Reply routing's title no longer wraps; Add client, Invite team member and the campaigns rate note stack on phones.

## Phase 4 — debt greps (UI_RULES.md "What it forbids")
Counts over `src/app` and `src/components` `.tsx` (globals.css for `!important`), on `master` at `98abf57` and on this branch. From the repo root:

```sh
grep -rhoiE --include='*.tsx' -e '-\[#(2E37FE|0F172A|EDEEFF|1C24B8|A3A8FF|6B72FF|64748B|E2E8F0|334155)\]' src/app src/components | wc -l   # token hex in classes
grep -rhoE --include='*.tsx' "background(Color)?:\s*['\"]#2E37FE" src/app src/components | wc -l                         # inline brand fills
grep -rlE --include='*.tsx' 'fixed inset-0' src/app src/components | grep -v components/ui/                               # hand-built overlays
grep -rlE --include='*.tsx' createPortal src/app src/components | grep -v components/ui/
grep -rhoE --include='*.tsx' '\bshadow-(sm|md|lg|xl|2xl)\b' src/app src/components | wc -l
grep -rhoE --include='*.tsx' '<Card\b[^>]*className="[^"]*(shadow-(sm|none|md|lg)|border-border/[0-9]+)' src/app src/components | wc -l
grep -rlE --include='*.tsx' linear-gradient src/app src/components
grep -c '!important' src/app/globals.css
```

Native selects are counted from each `<select` to its first `<option`, so an arrow function in a prop doesn't cut the match short; a select counts as drawn when that span names `ls-select` or a CSS-module select class.

| debt class | before | after | notes |
|---|---|---|---|
| token hex in class strings (`-[#2E37FE]`, `#0F172A`, `#EDEEFF`, `#1C24B8`, `#A3A8FF`, `#6B72FF`, `#64748B`, `#E2E8F0`, `#334155`) | 525 | **0** | other brands' colours (LinkedIn, Google) and rail tints stay by rule |
| inline `#2E37FE` backgrounds | 78 | **0** | 54 on Buttons dropped (the variant paints it), 20 tiles to `bg-primary`, 4 by hand |
| hand-built overlays (`fixed inset-0` outside `ui/`) | 5 | **1** | the one left is the phone drawer's dim in `sidebar.tsx` (a drawer, not a popup) |
| `createPortal` outside `ui/` | 1 | **0** | |
| native `<select>` not drawn by `ls-select` or a module select class | 24 of 28 | **0 of 28** | the flow tile's condition select is inline text by design (`.condSel`) |
| `shadow-sm…2xl` utilities | 152 | **2** | a switch knob (`linkedin-search-panel.tsx`) and the unused `ui/sheet.tsx` |
| `Card` shadow / hairline overrides | 125 | **13** | all 13 are Integrations panels inside their popup (`border-0 py-0 shadow-none`), allowed by rule |
| `linear-gradient` in `.tsx` | 6 files | **4 files** | sidebar (the rail, allowed); remaining debt below |
| `!important` in globals.css | 0 | 7 | allowed by rule: phone fields' 16px, the phone sheet's width and padding, reduced motion |

## Remaining
- **Gradients that predate this work** (3 files): the client reply page's avatar and tile fills (`client/inbox/[id]/page.tsx` `GRAD`, `GREEN`, `BLUE`, `SLATE`), the welcome page's green check tile (`billing/welcome-content.tsx`), the client onboarding modal's navy side panel (`client/onboarding-modal.tsx`, echoes the rail).
- **`ui/sheet.tsx`**: not imported anywhere; left as it was.
- **Seen during the sweep, unchanged** (the same on `master`, so not from this work): the Mailboxes inbox table squeezes its columns at phone width; on the client detail page the portal user row's Reports checkbox is cut off at the card's edge; on Team the member rows' chips are cut off on phones; on Tags and Tokens a long card description squeezes the header's icon tile on phones; the flow tile's condition select hides its focus outline (`.condSel:focus`).
- **Lint**: `npm run lint` reports 157 errors and 40 warnings, the same files and rules as on `master` (compared per file and rule); none come from this work.
- **Email templates**: out of scope by rule (they stay flat).
- **Dark mode**: deferred by rule.

## The Forge-rules pass (2026-10-31)

Daniel, 2026-10-31: "Take a deep dive through the app and the styling rules we've built through Forge. You need to adhere to these and restyle the app all the way through and check for conformity." The sixteen rules, their LeadStart parts, checks and measures are the table in `UI_RULES.md` ("The Forge rules, held in code"). Evidence here, per rule. Nothing committed: local only. Built without agents: the session's agent canary ran on the wrong model, so by the agent rule nothing was spawned.

**Evidence tiers added for this pass**
- **check** = `node scripts/style/check-all.mjs` (in `npm run typecheck`): eight file checks, each a port of Forge's. Green: `npx tsc --noEmit` clean, and `check-styling: 8 checks green`.
- **gate** = `node scripts/style/measure-gate.mjs` against the dev server on 3030 (signed in through `/app/api/dev/login`, read-only): 41 routes × 1440, 1024, 390 and 375, each at rest, with every fold opened, and with the phone drawer open on the phone sizes. Per screen: sideways (`scrollWidth === clientWidth` on the page and every vertical scroller), stacked cards (no sibling cards touching or overlapping), fold gaps (the same closed and open), glows (`measure-glows.js`), icons (`measure-icon-centers.js`, 0.25px) and buttons (`measure-button-labels.js`, 0.25px across, 0.5px up and down). Result: **156 screens measured, every measure empty.** 16 loads redirected and were not measured: `/buyer`, `/buyer/contacts`, `/buyer/search` and `/login` go to `/app/admin` under the admin login.
- **simulator** = the iOS 27 simulator (iPhone 18 Pro, Safari, the real on-screen keyboard), the page's own numbers read from a debugging overlay that was in `keyboard-reveal.ts` for the runs and removed after them, the keyboard's and form bar's frames from the accessibility tree where it exposes them (upright only), and the box's frame from the screenshot's pixels (3px = 1pt). The hardware keyboard was off (`axe type` turns it on and hides the soft keyboard; Forge's `scripts/sim/keyboard.swift` turns it off).

**Text boxes on a phone** (`lib/ui/keyboard-reveal.ts`), the runs:

| case | box | result |
|---|---|---|
| sideways, Safari's bars up | Welcome paragraph (86pt), buyer experience | guess 288 = reported 288, one reveal, no correction. Safari leaves a 4 to 17pt strip of page above the keyboard there, so no box can show; the box is put at the page's top (12pt). Safari's chrome, not the app. |
| sideways, bars folded | Saved reply (201pt) inside the campaign Setup tab's own scroller | guess 288 = reported 288, one reveal. The shell scrolled 190 (room lent), the panel's top to 12pt, the box capped to 74px at 24 to 98pt, the keyboard's top at 114pt (`visualViewport`), the form bar's glass from 125pt. Pixels: the box's bottom ring 99.3 to 100.7pt, its right ring 31 to 93pt. Done: the box grows back, the page stays where it was. |
| upright, bars up | Saved reply, same panel | guess 330 = reported 330. The shell scrolled 89 (49 lent), the panel's top to 155, the box at 167 to 368 in page terms (its ring at 229 and 431.7 to 433pt on screen), 16pt above the visible foot (page 384, screen 446, where Safari's address capsule starts); the form bar at 493. Done leaves the page where it was. The reveal was computed twice to the same place: the first glide's frames did not draw before Safari reported the keyboard (816ms after the tap on the simulator), so the second started from the same state; nothing moved twice. |
| upright, bars up | Banner text (87pt) on the page's own scroller | scrolled 246: the box's bottom border at 429.7 to 430.3pt on screen (page 368 = 16pt above the visible foot), the capsule at 445, the form bar at 493. Done leaves the page where it was. |
| upright, bars folded | | not reachable on this shell: `.app-shell-content` is the only scroller and takes every drag (tried on the panel, the page's foot and the Danger zone card), the document never scrolls, and Safari keeps its bars (`BarsKeptMinimized=false`). |

The max cases listed and checked: sideways (the smallest view) with the bars up and folded, the longest box (201pt) inside a nested scroller and a box on the page scroller, the keyboard going by Done, and typing (nothing moves but the text; measured in the earlier Welcome-paragraph run, text scrolling inside a fixed-rows box with the cursor's line in sight). Limits: the checks ran in Safari, not the Home Screen app's mode (its login can't be reached without a password); the first keyboard of a kind has no remembered height, so that first box comes up on Safari's report rather than ahead of it (Forge's rule says the same); the admin inbox composer could not be opened (every Interested thread was already replied to) and LeadStart has no docked chat box, so the chat rule has no surface. Headless WebKit at phone size was used for layout numbers only: its pages' Supabase calls fail on CORS, so lists there are empty.

**The rest, per rule**

| rule | evidence | result |
|---|---|---|
| Bleed must be paid back | gate | sideways 0 and stacked 0 on all 156 screens |
| Glows are never capped | gate (`measure-glows.js`) | 0 cut, 0 borrowed strips over a press; before the fixes the shell's content edge, the prospects board's column and the tag chip input's panel cut card shadows, and the tab bar's clipped glass counted as a cut glow |
| Shift while typing | focus tier (task #228), unchanged | pass |
| Chat on a phone | no surface | |
| Search on a phone | code + gate | the hits list is its own scroller (`overflow-y-auto overscroll-contain touch-pan-y`), back at its top before the frame on each new query; sideways 0 |
| Text boxes on a phone | check + simulator | the table above |
| Smooth transitions | check (`check-popups.mjs`, `check-open-in-place.mjs`) | every hand-drawn menu is a `Grown`; no CSS variable eases |
| Expand and collapse | check (`check-folds.mjs`) + gate | every `aria-expanded` opens a `Fold` or `Grown`; the gate opened every fold on every screen: fold gaps 0 off |
| Cards on a phone | check (`check-card-press.mjs`) + simulator | every pressable row or card goes through `useCardPress`; a 1.2s hold on an inbox row used to select a word of its preview, now `user-select: none` and no callout |
| Icons centred | check (`check-icon-centers.mjs`) + gate | 148 Lucide icons centred (24 by `icon-centers.css`); icons 0 off on 156 screens |
| Button's words centred | check (`check-button-labels.mjs`) + gate | 559 flex or grid buttons say where their words sit, 95 padded controls even; buttons 0 off on 156 screens |
| A control that grows and shrinks | code + gate | the tab bar's condense on transforms and opacity only; the gate measures glows again at the end of every scroller, where the bar is condensed: 0 cut |
| Check the max cases | this section | |
| A screen opens in its place | check (`check-open-in-place.mjs`) | no `useEffect` sets a scroller's end; no eased variable |
| A conversation reaches back | code | no conversation loads in parts; the opens-in-place half is the check above |
| Every popup closes the same way | check (`check-popups.mjs`) + popup tier (task #228) | no dim or dialog outside the two popup files; the phone drawer pulls shut, Esc and the dim close it |
| Buttons are flat | check (`check-flat-buttons.mjs`) | every sheen a 140° linear gradient, no dome |

## The flat-contract sweep (2026-08-22), replaced
Started 2026-08-22 via `/style-sweep`: every hero band moved onto the shared `PageHeader`, the sidebar, topbar, primitives and charts went flat, the auth pages became one centred card, and decorative gradients in `.tsx` reached 0 (emails and the disabled site-chat widget excepted). Its full ledger is in git history (`git show 98abf57:STYLE_SWEEP.md`).
