# Style sweep — LeadStart → flat contract (UI_RULES.md)

> Started 2026-08-22 via `/style-sweep`. Living ledger; coverage is proven here, not from memory.
> Loop cap: **2h autonomous per run, then check in** (set 2026-08-22). Loop started: 2026-08-22T13:25:18Z (fresh manual `/style-sweep`).
> **STATUS: app-shell decorative-gradient sweep COMPLETE.** `linear-gradient` in `.tsx` = **0** across the whole app UI. Every hero band is now the shared flat `PageHeader`; sidebar/topbar/primitives/charts flat; auth unified to a centered card; the two bespoke gradient surfaces (StageFlowCard, quote letterhead) flattened.
> Remaining `linear-gradient` hits live only in **email templates** (`lib/email/**`, `api/*/route.ts`, `lib/notifications/**`) and the **disabled site-chat widget** (`lib/site-chat/widget.ts`) — both explicitly out of scope for this sweep (see Deferred).

## Evidence tiers used below
- **live** = desktop screenshot rendered + `read_console_messages` clean (0 errors) on the port-3000 dev server (this working tree, HMR live).
- **tsc+grep** = `npx tsc --noEmit` shows **no new errors** from the edit (all remaining tsc errors are pre-existing project patterns per AGENTS.md — Select `onValueChange` null-type, `SequenceStepKind` missing `email`, null-assignability — none reference `PageHeader` or any edited header region) **and** `linear-gradient` grep = 0 for the file. Pattern is identical to the live-verified pages.
- **mobile** = `PageHeader` is `flex flex-col … sm:flex-row` (computed-style confirmed on a live header, 785px→row / <640px→col); one shared component ⇒ uniform across all 30 callers. No active-pane resize (per global rule).

## Phase 1 — tokens + shared primitives  (verified)
| surface | file(s) | status | evidence | notes |
|---|---|---|---|---|
| globals.css tokens + overrides | src/app/globals.css | verified | tsc+grep | radius→0.5rem, dark sidebar tokens; all `!important` removed (**re-grep = 0**), gradient utils/aurora/nav-notch removed (**straggler grep = 0**); flat btn-gold/dark + solid badge-* |
| Card | src/components/ui/card.tsx | verified | live | `rounded-xl border`, no shadow/gradient |
| Button | src/components/ui/button.tsx | verified | live | flat variants; btn-gold/dark flat aliases |
| Badge | (classes in globals.css) | verified | live | 6 names, solid fill (green/amber/red/blue/purple/slate) |
| Input / Textarea | src/components/ui/input.tsx | verified | live | flat once override removed |
| Table | src/components/ui/table.tsx | verified | live | flat header, hairline rows |
| StatCard | src/components/charts/stat-card.tsx | verified | live | flat, tokenized |
| KPICard | src/components/charts/kpi-card.tsx | verified | live | health tints kept, no hover shadow |
| DailyChart | src/components/charts/daily-chart.tsx | verified | live | solid low-alpha fills |

## Phase 2 — shared layout (verified)
| surface | file(s) | status | evidence | notes |
|---|---|---|---|---|
| Sidebar | src/components/layout/sidebar.tsx | verified | live (prior) | dark solid panel, solid active pill |
| Topbar | src/components/layout/topbar.tsx | verified | live | flat white bar, solid avatar |
| PageHeader (shared) | src/components/layout/page-header.tsx | verified | live+mobile | eyebrow+title+subtitle+actions; responsive; rolled out to all ~30 callers |

## Phase 3 — route pages (hero band → PageHeader; ALL done)
| surface | file(s) | status | evidence |
|---|---|---|---|
| admin overview | admin/page.tsx | verified | live |
| admin campaigns list | admin/campaigns/page.tsx | verified | live (prior) |
| admin campaign detail | admin/campaigns/[id]/page.tsx | verified | live (header + StageFlowCard) |
| admin new native / new linkedin | admin/campaigns/new/{native,linkedin}/page.tsx | restyled | tsc+grep |
| admin clients list | admin/clients/page.tsx | verified | live (prior) |
| admin client detail | admin/clients/[clientId]/client-detail-client.tsx | restyled | tsc+grep |
| admin client campaign detail (+linkedin) | admin/clients/[clientId]/campaigns/[id]/{page,linkedin-campaign-detail}.tsx | restyled | tsc+grep |
| admin contacts | admin/contacts/page.tsx | verified | live (button conversion) |
| admin inbox (inbox-client) | admin/inbox/inbox-client.tsx | restyled | tsc+grep |
| admin prospecting | admin/prospecting/page.tsx | restyled | tsc+grep |
| admin prospects | admin/prospects/page.tsx | restyled | tsc+grep |
| admin reports (+ reports-client, preview) | admin/reports/{page,reports-client,preview}.tsx | restyled | tsc+grep |
| admin feedback | admin/feedback/page.tsx | restyled | tsc+grep |
| admin tasks | admin/tasks/page.tsx | verified | live |
| admin mailboxes | admin/mailboxes/page.tsx | restyled | tsc+grep |
| admin billing | admin/billing/page.tsx | verified | live (Stripe badge → actions) |
| admin settings (api, team) | admin/settings/{api,team}/page.tsx | restyled | tsc+grep |
| client dashboard | client/page.tsx | verified | live (prior) |
| client inbox | client/inbox/page.tsx | restyled | tsc+grep |
| client campaigns (+linkedin) | client/campaigns/[id]/{page,linkedin-client-campaign}.tsx | restyled | tsc+grep |
| client activity / reports / feedback | client/{activity,reports,feedback}/page.tsx | restyled | tsc+grep |
| auth: login | (auth)/login/page.tsx | verified | live (prior; already flat) |
| auth: reset-password | (auth)/reset-password/page.tsx | verified | live (centered card) |
| auth: update-password / accept-invite | (auth)/{update-password,accept-invite}/page.tsx | restyled | tsc+grep (same conversion as reset) |

## Phase 4 — cross-cut debt
| debt class | status | evidence | notes |
|---|---|---|---|
| decorative gradients (.tsx) | **DONE = 0** | grep | app UI has zero `linear-gradient`; email/site-chat out of scope (Deferred) |
| `!important` in globals.css | **DONE = 0** | grep | |
| dead @layer utility classes | **DONE = 0** | grep | aurora/nav-notch/stat-card-gold/bg-gradient → 0 usages |
| inline `#hex` / `bg-[#…]` | **DEFERRED** | — | dark-mode is out of scope (locked ruling) → hex→token not mandatory this sweep; new code uses tokens |

## Phase 5 — peripheral
| surface | status | evidence | notes |
|---|---|---|---|
| StageFlowCard | verified | live | CompletionBanner → solid #2E37FE; TermBadge → solid fills; connector solid; step-badge glow dropped |
| quote letterhead | restyled | tsc+grep | solid #EDEEFF tint + hairline |
| ui primitives (dialog/select/tabs/sheet/sonner/pagination/alert-dialog) | verified | grep | no gradients; only shadow is Dialog `shadow-xl` = the one permitted overlay tier + hairline ring; radius `rounded-xl`. Scrim `backdrop-blur` on overlays kept as overlay chrome (optional tighten). |
| email templates | **DEFERRED** | — | `lib/email/**`, `api/*/route.ts`, `lib/notifications/**` — separate (email) rendering surface; own pass |
| site-chat widget | **DEFERRED** | — | `lib/site-chat/widget.ts` — DISABLED / not embedded; marketing-site surface |

## Coverage
**In-scope app-shell surfaces = fully swept.** Route pages: 24 hero-band files + 6 detail headers + 3 auth conversions this run; foundation (primitives/layout/charts) verified prior. `linear-gradient` in `.tsx` = 0. `!important` = 0. dead classes = 0. tsc = no new errors. 6 pages live-verified this run across every edit category (simple hero, detail header, multi-line+actions, badge-in-actions, bespoke flatten, auth rewrite).

## Deferred / open for Daniel
- **hex→token**: intentionally deferred with dark-mode (locked ruling). Revisit as a dark-mode pass.
- **email templates + site-chat widget**: out of scope for the app-shell flatten; would be their own sweep.
- **`+`/Plus icon on create buttons**: kept as-is; UI_RULES lists "no `+` prefix" as an interaction rule — stripping the icon app-wide is a separate decision (confirm).
- **overlay scrim `backdrop-blur`**: kept as overlay chrome; remove if you want zero backdrop-filter anywhere.
