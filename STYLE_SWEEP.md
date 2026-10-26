# Style sweep — LeadStart → Forge style, LeadStart colours (UI_RULES.md)

> Task #228 from LeadStart App's queue, swept 2026-10-26. Living ledger: coverage is proven here by measurement, not from memory. The flat-contract sweep of 2026-08-22 it replaces is summarised at the end.
> **STATUS: swept.** Tokens, shared parts and the shell are on the new contract; 44 pages measured at 1440, 1024, 390 and 375 with no sideways scroll and no touching or overlapping cards; the debt greps below are at their targets except the items listed under "Remaining".

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

## The flat-contract sweep (2026-08-22), replaced
Started 2026-08-22 via `/style-sweep`: every hero band moved onto the shared `PageHeader`, the sidebar, topbar, primitives and charts went flat, the auth pages became one centred card, and decorative gradients in `.tsx` reached 0 (emails and the disabled site-chat widget excepted). Its full ledger is in git history (`git show 98abf57:STYLE_SWEEP.md`).
