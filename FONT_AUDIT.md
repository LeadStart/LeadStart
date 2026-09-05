# Font consistency audit: Poppins conformance

> Run: 2026-09-05 · Branch `claude/font-consistency-audit-ce8fb1` · Status: **Tiers 1 and 2 and the em
> dash sweep are all done (local, uncommitted).** Full detail in the Change log at the bottom.
>
> Design contract: [`UI_RULES.md`](UI_RULES.md) line 9: *"**Font** | Keep **Poppins** (body + headings). No font swap."*

## Headline

**The app is 100% Poppins. Verified, not assumed.** All 177 `.tsx` files render under one document root
(`src/app/layout.tsx`), and computed styles on production confirm Poppins on `html`, `body`, `button`,
`input`, and `label`. There is no second font leaking into any app surface.

The inconsistency was **outside** the app: 17 email templates declared `'Inter'`, which is not
LeadStart's brand font and was never actually loaded. **Fixed 2026-09-05** (see the Change log): every
HTML email now declares Poppins first, through the single shared constant in
[`src/lib/email/brand.ts`](src/lib/email/brand.ts).

There was also one genuine in-app defect: weight 800 was used in 5 places but never loaded, so
`font-extrabold` rendered pixel-identical to `font-bold`. **Fixed 2026-09-05** and measured: the sidebar
wordmark went from 126.97px to 128.75px once a real 800 face was loaded. See Tier 1 below.

## Known vs assumed ledger

| Claim | Status | Evidence |
|---|---|---|
| App computes to Poppins on prod | **VERIFIED** | `getComputedStyle` on https://leadstart-ebon.vercel.app/app/login returns `Poppins, "Poppins Fallback"` for html/body/button/input/label; `--font-sans` = `"Poppins", "Poppins Fallback"` |
| No 800 face exists | **VERIFIED** | `document.fonts` on prod lists Poppins faces at 400/500/600/700 only. Rendered width of the same string at weight 700, 800 and 900 is identical (126.97px), so 800 descends to the 700 face |
| Only two document roots exist | **VERIFIED** | `grep -rln "<html lang"` returns `src/app/layout.tsx` + `src/app/global-error.tsx` only |
| No stray font imports in app code | **VERIFIED** | zero `font-[...]` arbitrary utilities, zero `fonts.googleapis` links in `src/`, zero `font-serif`, only 2 `next/font` imports |
| No email loads a webfont | **VERIFIED** | zero `@font-face`, `@import url`, or `fonts.googleapis` hits across `src/lib/email/`, `src/lib/notifications/`, and the 4 `api/*` mailers |
| Apple Mail approx. 51% of opens and renders webfonts; Gmail / Outlook Windows / Outlook.com / Yahoo strip them | **VERIFIED (external)** | Litmus Feb 2026 data, via Omnisend and Courier email-font guides (see Sources at the bottom) |
| Poppins woff2 subset weight cost | **UNKNOWN** | not measured. Adding weight 800 adds one more subset file; size not benchmarked |

## Class A: The app. Conformant, with 5 surgical defects.

> **Status 2026-09-05: A1, A2, A3 and A4 are all FIXED** (see Tier 1 for the measured evidence). A5 was
> deliberately deferred and is still open by choice. The findings below are kept as written so the
> reasoning survives; they describe the pre-fix state.

### A1. Weight 800 used but never loaded (highest value fix)

`src/app/layout.tsx:10` loads `weight: ["400", "500", "600", "700"]`. These 5 sites ask for 800 and
silently get 700:

| Site | Usage | Visibility |
|---|---|---|
| [`src/components/layout/sidebar.tsx:187`](src/components/layout/sidebar.tsx:187) | `font-extrabold` on the LeadStart wordmark | **Every dashboard page** |
| [`src/components/workflows/onboarding-preview.tsx:130`](src/components/workflows/onboarding-preview.tsx:130) | `font-extrabold` on an `h1` | Admin → Workflows |
| [`src/components/workflows/enrichment-flow-map.tsx:48`](src/components/workflows/enrichment-flow-map.tsx:48) | `fontWeight: 800` on SVG text | Admin → Workflows |
| [`src/components/workflows/enrichment-flow-map.module.css:8`](src/components/workflows/enrichment-flow-map.module.css:8) and `:33` | `font-weight: 800` on `.title` / `.cap` | Admin → Workflows |
| [`src/components/campaigns/flow/flow.module.css:214`](src/components/campaigns/flow/flow.module.css:214) | `font-weight: 800` on `.abK` | Flow builder |

**Recommended fix:** add `"800"` to the weight array. Two one-line edits, because the two document roots
must stay in lockstep:
- `src/app/layout.tsx:10`
- `src/app/global-error.tsx:16`

**Rejected alternative:** demote the 5 sites to `font-bold`. That is also one line per site, but the
sidebar wordmark is a deliberate brand mark and the flow-map titles want the extra weight. Loading the
face preserves design intent instead of quietly abandoning it.

### A2. `global-error.tsx` drifts from `layout.tsx`

The file's own comment (line 10) says it mirrors the root layout. It does not, in two ways:

1. It imports **only** Poppins, not `JetBrains_Mono`, yet renders `className="font-mono"` at
   [`global-error.tsx:44`](src/app/global-error.tsx:44). `--font-geist-mono` is undefined there, so
   `font-family: var(--font-mono)` is invalid at computed-value time and the digest code **inherits
   Poppins** instead of rendering mono.
2. Its `<body>` at line 34 lacks the `font-sans` class that [`layout.tsx:48`](src/app/layout.tsx:48)
   carries. Harmless today because `globals.css` has `html { @apply font-sans }`, but it is drift
   between two files meant to be identical.

**Fix:** import `JetBrains_Mono` with `variable: "--font-geist-mono"` in `global-error.tsx`, and add
`font-sans` to its `<body>`. Alternatively drop the `font-mono` class from line 44 if mono is not wanted
on the error page. Low blast radius, but this is the one place the font contract silently differs.

### A3. Mono token bypassed in 2 places

The app has 103 `font-mono` usages that correctly resolve to JetBrains Mono. Two spots hardcode the OS
mono stack instead, so those labels render in a different mono face than the rest of the app:

- [`src/components/workflows/enrichment-flow-map.tsx:37`](src/components/workflows/enrichment-flow-map.tsx:37)
  `const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace"`, applied to 6 SVG text styles
  (lines 41, 43, 44, 45, 46, 105).
- [`src/components/workflows/enrichment-flow-map.module.css:13`](src/components/workflows/enrichment-flow-map.module.css:13)
  `.hint { font-family: ui-monospace, monospace; }`

**Reference pattern already in the repo:**
[`src/components/campaigns/flow/flow.module.css:150`](src/components/campaigns/flow/flow.module.css:150)
does it correctly with `var(--font-mono, monospace)`. Copy that.

### A4. Misleading fallback literal names the wrong brand's font

[`src/components/workflows/enrichment-flow-map.module.css:37`](src/components/workflows/enrichment-flow-map.module.css:37)
`.svg text { font-family: var(--font-sans, "Inter", system-ui, sans-serif); }`

Resolves to Poppins in practice, because `--font-sans` is always defined. But it names Inter as the
intended fallback, which is wrong for this brand and will mislead the next person who reads it.
**Fix:** `var(--font-sans, system-ui, sans-serif)`.

### A5. Naming debt (recommend deferring)

`--font-geist-mono` is a leftover variable name from the Geist starter template; the font it holds is
JetBrains Mono. Renaming touches `layout.tsx`, `global-error.tsx`, and `globals.css:11`. Pure hygiene,
zero visual change, so it is churn without payoff. **Defer.**

Also worth knowing, not a defect: `--font-heading` is aliased to `--font-sans` in `globals.css:12`, so
the 5 `font-heading` usages (in `card.tsx`, `dialog.tsx`, `sheet.tsx`, `alert-dialog.tsx`,
`global-error.tsx`) are a no-op abstraction today. That is deliberate headroom for a future heading
font. Leave it.

## Class B: Emails. The actual inconsistency.

> **Updated 2026-09-05.** The cold-outreach builder no longer emits HTML at all, so it has no font stack
> left to audit. See the Change log at the bottom. The counts below are the post-change state.

**22 files** emit HTML email with a hardcoded font stack. All 22 are branded transactional templates.

**Original finding (now fixed):** none loaded a webfont, none mentioned Poppins, and **17 declared
`'Inter'` first**, a font that is neither the brand font nor ever actually loaded. Every one of those 22
now pulls its stack from [`src/lib/email/brand.ts`](src/lib/email/brand.ts), which names Poppins first
and carries the Outlook guard. The file tables below record the pre-change state for history.

Verified counts: `grep -rl "'Inter'"` returns 17 files; `grep -rl "font-family"` across `src/` minus the
site-chat widget returned 23 before the cold-email change and 22 after.

### Client / buyer facing (brand actually matters)

| File | Current stack |
|---|---|
| [`src/lib/email/quote-proposal.ts:71`](src/lib/email/quote-proposal.ts:71) | `'Inter', -apple-system, ...` |
| [`src/lib/email/invoice.ts:148`](src/lib/email/invoice.ts:148) | `'Inter', -apple-system, ...` |
| [`src/lib/email/subscription-started.ts:41`](src/lib/email/subscription-started.ts:41) | `'Inter', -apple-system, ...` |
| [`src/lib/email/payment-failed.ts:34`](src/lib/email/payment-failed.ts:34) | `'Inter', -apple-system, ...` |
| [`src/lib/email/low-balance.ts:26`](src/lib/email/low-balance.ts:26) | `'Inter', -apple-system, ...` |
| [`src/lib/email/portal-link.ts:15`](src/lib/email/portal-link.ts:15) | `'Inter', -apple-system, ...` |
| [`src/lib/email/weekly-report.ts:33`](src/lib/email/weekly-report.ts:33) | `'Inter', -apple-system, ...` |
| [`src/lib/notifications/client-email.ts:295`](src/lib/notifications/client-email.ts:295) | `'Inter', -apple-system, ...` |
| [`src/lib/email/templates/confirmation.html:8`](src/lib/email/templates/confirmation.html:8) | `'Inter', -apple-system, ...` |
| [`src/lib/email/templates/invite.html:8`](src/lib/email/templates/invite.html:8) | `'Inter', -apple-system, ...` |
| [`src/lib/email/templates/magic-link.html:8`](src/lib/email/templates/magic-link.html:8) | `'Inter', -apple-system, ...` |
| [`src/lib/email/templates/recovery.html:8`](src/lib/email/templates/recovery.html:8) | `'Inter', -apple-system, ...` |
| [`src/app/api/invite/route.ts:18`](src/app/api/invite/route.ts:18) | `'Inter', -apple-system, ...` |
| [`src/app/api/signup/route.ts:37`](src/app/api/signup/route.ts:37) | `'Inter', -apple-system, ...` |
| [`src/app/api/reset-password/route.ts:106`](src/app/api/reset-password/route.ts:106) | `'Inter', -apple-system, ...` |

### Owner / internal only (brand does not matter, lowest priority)

| File | Current stack |
|---|---|
| [`src/lib/email/quote-signed.ts:53`](src/lib/email/quote-signed.ts:53) | `'Inter', ...` (goes to admin, carries `adminUrl`) |
| [`src/lib/notifications/owner-heartbeat.ts:1357`](src/lib/notifications/owner-heartbeat.ts:1357) | `'Inter', ...` |
| [`src/lib/notifications/owner-alerts.ts:339`](src/lib/notifications/owner-alerts.ts:339) | `system-ui, ...` |
| [`src/lib/notifications/actor-failure-alert.ts:63`](src/lib/notifications/actor-failure-alert.ts:63) | `system-ui, ...` |
| [`src/lib/notifications/internal-automations.ts:225`](src/lib/notifications/internal-automations.ts:225) | `system-ui, ...` |
| [`src/lib/notifications/webhook-auth-alerts.ts:261`](src/lib/notifications/webhook-auth-alerts.ts:261) | `system-ui, ...` |
| [`src/app/api/contact/route.ts:57`](src/app/api/contact/route.ts:57) | `-apple-system, ...` (contact form to the team) |

### RESOLVED 2026-09-05: the cold-outreach builder has no font stack any more

[`src/lib/gmail/mime.ts`](src/lib/gmail/mime.ts) used to build the cold-outreach body as
`multipart/alternative` with an HTML twin carrying a system font stack. It is now a **single `text/plain`
part**, so there is no font, no HTML, and nothing here to bring in line with Poppins. A cold email should
look like a human typed it in Gmail, not like a designed marketing blast.

This is a permanent exclusion from any future font sweep: **never add a font stack to the cold-email
path.** See the Change log for how the reflow problem was solved without HTML.

## Class C: Static HTML in `public/`

| File | Font | Verdict |
|---|---|---|
| `public/operator-guide/index.html`, `public/operator-guide/01-getting-started.html` | **Poppins** 300-800 + JetBrains Mono, via Google Fonts CDN | **Already conformant.** Note it has 300 and 800 available while the app does not (see A1) |
| `public/workflows/outbound-pipeline.html` | Inter + JetBrains Mono | Internal reference doc, not a client surface. Low priority |
| `public/perf-audit.html` | system + SF Mono | One-off dev artifact. Leave |

## Class D: Needs a decision from Daniel

[`src/lib/site-chat/widget.ts:85`](src/lib/site-chat/widget.ts:85) hardcodes a system stack. This widget
injects into the **marketing site**, which is a separate repo
(`C:\Users\danie\Documents\LeadStart Website`), and per project memory it is currently **disabled / not
embedded**. It is a brand surface, but it renders inside a third-party page. Open question: brand it to
Poppins, or keep it neutral so it inherits the host page?

## Recommended plan, in priority order

### Tier 1: DONE 2026-09-05. All four defects fixed and verified in a running app.

1. **A1** weight 800 loaded in both document roots (`layout.tsx`, `global-error.tsx`).
2. **A2** `global-error.tsx` now imports `JetBrains_Mono`, puts both font variables on `<html>`, and
   carries `font-sans` on `<body>`, so it genuinely mirrors the root layout.
3. **A3** both hardcoded mono stacks now read `var(--font-mono, ...)`.
4. **A4** the `"Inter"` literal is gone from the flow-map SVG fallback.

**Evidence (measured, not asserted).** The same probe that proved the defect, re-run against the app:

| Weight | Production, before | Local, after |
|---|---|---|
| 700 | 126.97px | 126.97px |
| 800 | **126.97px** (silently collapsed to 700) | **128.75px** (distinct) |

`document.fonts` now reports a loaded Poppins `800` face where production has none, and the REAL sidebar
wordmark element (not a synthetic probe) computes to `font-weight: 800`, `Poppins, "Poppins Fallback"`,
rendering at 128.75px.

On Admin → Workflows: every SVG label and `.hint` now computes to `"JetBrains Mono", "JetBrains Mono
Fallback"`, **0** elements remain on the raw OS mono stack, and **no element anywhere on the page
resolves to Inter**. No console errors.

**One caveat, stated plainly:** A2 is verified by typecheck and code inspection, NOT by rendering.
`global-error.tsx` only replaces the root layout when that layout itself throws, which does not happen in
dev. The font wiring is now structurally identical to `layout.tsx`, but nobody has seen it render.

**Verified prerequisite:** `--font-mono` really is emitted as a CSS custom property despite the
`@theme inline` declaration in `globals.css:11`. Checked on production before relying on it, because if
Tailwind had inlined it away, the A3 fix would have silently fallen through to the OS mono stack.

### Tier 2: DONE 2026-09-05. The email brand fix.
Replace `'Inter'` with `'Poppins'` as the first family across the **15 client/buyer-facing** templates,
and add a Google Fonts `<link>` in the `<head>` of those templates.

Why this ordering and not "Poppins everywhere": per the verified Litmus Feb 2026 data, Apple Mail is
about 51% of opens and renders webfonts, while Gmail, Outlook for Windows, Outlook.com and Yahoo strip
them. So a webfont buys real Poppins for roughly half of opens and nothing for the rest, which means the
**fallback stack matters as much as the webfont**. Target stack:

```
font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
```

Note: the 4 `src/lib/email/templates/*.html` files are **Supabase auth templates**, so changing them may
require re-pasting into the Supabase dashboard rather than just a deploy. Confirm before counting them done.

### Tier 3: Optional / decide first.
- The 7 owner-internal emails: cheap to align for consistency, zero brand value. Recommend leaving them.
- `public/workflows/outbound-pipeline.html`: internal doc, align only if it bothers you.
- **Class D** widget font: needs Daniel's call.
- **A5** `--font-geist-mono` rename: recommend never.

## Explicitly NOT changing
- `src/lib/gmail/mime.ts` (cold outreach, now plain text with no font at all)
- `public/perf-audit.html` (dev artifact)
- `--font-heading` alias (deliberate headroom)

## Change log

### 2026-09-05: cold email to plain text, transactional gains a text part

Scope decision by Daniel: cold outreach only goes plain-text-only. The transactional tier **keeps its
HTML**, so the branded quote / welcome / invoice surfaces and the
`scripts/test-onboarding-preview-sync.ts` contract are untouched.

**1. Cold outreach is now single-part `text/plain`.** `buildRawEmail()` no longer emits
`multipart/alternative`, no HTML part, no MIME boundary, no font stack.

The reason the HTML part existed was real, not folklore: Gmail honours literal newlines in a
`text/plain` body and ignores RFC 3676 `format=flowed`, so a pre-wrapped body renders as a narrow column
([Mathias Bynens](https://mathiasbynens.be/notes/gmail-plain-text),
[Gmail Community](https://support.google.com/mail/thread/24488072/plaintext-hard-text-wrap?hl=en)).
The fix was the **transfer encoding**, not an HTML twin: `toQuotedPrintable()` (RFC 2045) splits one long
logical paragraph across physical lines with soft breaks that the client removes on decode, so Gmail
reassembles a single long line and reflows it to the reader's viewport.

Covered by `scripts/test-mime-quoted-printable.ts` (39 assertions: byte-for-byte round-trip, the 76-char
ceiling, escapes never split across a soft break, and no `text/html` or boundary in the output).

**2. Every transactional email now ships a `text/plain` alternative.** Before this change all 17 outbound
Resend paths sent single-part `text/html` with no text part, which is a spam-filter signal and unreadable
with HTML off. `ResendSendParams` had no `text` field to pass.

- `sendViaResend()` now derives `text` from `html` when the caller omits it, which covers its 8 callers
  centrally.
- The 9 direct `resend.emails.send()` call sites pass `text: htmlToPlainText(html)` explicitly.
- New `src/lib/email/html-to-text.ts` does the derivation. It preserves link destinations
  (`<a href="U">L</a>` becomes `L: U`) because a transactional email is mostly a call to action.
- Covered by `scripts/test-html-to-text.ts` (39 assertions, including running the REAL
  `buildPortalLinkEmail` and `buildQuoteProposalEmail` templates and asserting the CTA URL survives).

**3. Em dashes stripped from client-facing email text.** Subjects in `stripe/webhooks.ts` (3),
`send-reports`, `client-email.ts`, `invoices/[id]/send`, `contact`, `reset-password`; body copy in
`invite`, `reset-password`, `contact`; plus 3 user-facing API error strings. `htmlToPlainText` also
normalises em dashes to hyphens, so every derived text part is em-dash free by construction.

**Verification:** `tsc --noEmit` exits 0 repo-wide; both new suites pass 39/39.

### 2026-09-05 (later): repo-wide em dash sweep, and Tier 2 shipped

**1. Em dash sweep.** My earlier estimate of "~150" was wrong by 17x: it came from scanning only the
email paths. The real repo-wide count was **2,547 occurrences across 533 code files**.

Swept **2,254 lines across 458 files**, plus 60 follow-up grammar fixes where a colon had landed in front
of a coordinating conjunction. The general rule maps a spaced em dash to a colon, or to a comma inside parentheses
and where the clause already carries a colon. 36 lines carrying paired em dashes were hand-authored
rather than auto-transformed, because several were not parentheticals at all but two separate labels on
one line, where a blanket rule would have corrupted the string.

**Deliberately left, and why:**

| Kept | Count | Reason |
|---|---|---|
| `supabase/migrations/**` | 223 | An applied, append-only ledger. Editing historical migrations is not a copy fix |
| Empty-cell placeholders (the bare glyph used as a "no value" marker) and dividers such as the "Skip" and "end" select labels | 104 | Table typography, not prose. Swapping to a hyphen is a visible UI downgrade, and the rule's own carve-out for ranges shows it targets prose punctuation. **Open question for Daniel** |
| Regex character classes matching hyphen/en-dash/em-dash, and the html-to-text normaliser | 7 | Load-bearing: the literal character is what the code matches |

One catch worth naming: the sweep initially rewrote the **default cold-email body** in
[`src/lib/flow/graph.ts`](src/lib/flow/graph.ts), the highest-stakes prose in the repo. Both the
signature dash and a stiff colon were hand-corrected afterwards.

**2. Tier 2 shipped.** All 17 HTML email templates now declare Poppins first via
[`src/lib/email/brand.ts`](src/lib/email/brand.ts). Zero `'Inter'` remains in `src/`.

The non-obvious part is the **Outlook guard**. Outlook on Windows uses the Word engine, which falls back
to **Times New Roman** when it meets an unrecognised font family, ignoring the rest of the stack
([Email on Acid](https://www.emailonacid.com/blog/article/email-development/making-custom-font-stacks-work-in-outlook-update/),
[HTeuMeuLeu](https://medium.com/emails-hteumeuleu/today-i-learned-about-mso-generic-font-family-85b0e4703079)).
Naming Poppins first without guarding would have made Outlook **worse** than before, not better. So the
webfont `<link>` sits inside a downlevel-revealed conditional that hides it from Outlook, and a separate
mso-only block pins Outlook to Arial. The non-mso block omits `!important` so any element with its own
inline font-family still wins.

`src/lib/notifications/owner-heartbeat.ts` and `src/lib/email/quote-signed.ts` were owner-internal and
scoped as Tier 3, but were included anyway: with the shared constant in place the marginal cost was
nil, and leaving two files declaring a non-brand font would have been a half-job. The heartbeat is an
HTML fragment with no `<head>`, so it takes the stack only, not the webfont link.

Covered by `scripts/test-email-brand.ts` (40 assertions, including that the new `<style>` blocks do not
leak CSS into the plain-text alternative).

**Verification for both:** `tsc --noEmit` exits 0; 151 assertions pass across 5 suites
(`test-email-brand` 40, `test-html-to-text` 39, `test-mime-quoted-printable` 39,
`test-onboarding-preview-sync` 22, `test-flow-map-sync` 11). ESLint reports 31 errors repo-wide and
**none sit on a line this change touched**; all are pre-existing react-hooks / no-explicit-any /
prefer-const issues.

**Still open:** Tier 1 (the app's missing weight 800, the two hardcoded mono stacks, the `global-error`
mono drift) has NOT been done. The site-chat widget font is still an open question.

## Sources
- [Email-safe fonts vs. custom fonts (Omnisend, 2026)](https://www.omnisend.com/blog/email-safe-fonts-vs-custom-fonts/)
- [Fonts in email: what works, what breaks (Courier)](https://www.courier.com/blog/fonts-in-email-what-works-what-breaks-and-how-to-fix-it)
