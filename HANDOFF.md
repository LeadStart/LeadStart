# HANDOFF — LeadStart

> Rolling session-continuity log. Newest entry on top. Roll old entries to
> `HANDOFF_ARCHIVE_<period>.md` once this passes ~60 KB.

---

## 2026-08-26 — A/B auto-winner made OPT-IN + rigorous winner rule (owner-directed); LOCAL-ONLY, awaiting push

Follow-up to the auto-winner entry below, per owner review ("too aggressive; make it
per-node configurable" + "winner determination needs to be better defined"). Two changes:

**1. OFF by default, opt-in.** The auto-winner no longer runs on every A/B test. Resolution:
per-node `EmailNode.ab_config.autoPause` (tri-state: on / off / **inherit**) → per-campaign
`campaigns.ab_auto_pause_default` (migration **00091**, applied) → false. UI: a campaign-settings
toggle (Schedule tab of `campaign-detail-workspace`) + a per-node "Auto-winner" select in the
builder (`flow-editor` `EmailVariants`, shown only on A/B nodes). `resolveAbConfig(node,
campaignDefault)` does the cascade; `evaluateAbWinners` takes the campaign default (read in
`sync-analytics`); the display shows the effective on/off.

**2. Winner rule "better defined"** (owner picked "Significant + real lead"). A challenger is
paused only when ALL hold: ≥30 sends/variant & ≥60 total · leader ≥3 positives · leader leads by
**≥1.0 pt** on positive-reply rate · one-sided two-proportion z-test with a **Bonferroni**
correction across live challengers (3+ variants ⇒ higher bar). Winner is locked only once it has
beaten every rival. Replaces the old bare-significance test (which could crown a trivially-
significant or thin-evidence lead). All six knobs per-node-tunable; `DEFAULT_AB_WINNER_CONFIG`
= autoPause:false · 30/60 · 3 positives · 1.0pt · 95%.

**Storage note (why a migration this time):** the per-node flag rides in `flow_graph` JSONB (no
migration), but the per-campaign DEFAULT is a first-class campaign setting saved through
`update-sequence` alongside `daily_new_leads_cap`/`sending_strategy` — so it's a campaign column.
Migration 00091 = `campaigns.ab_auto_pause_default boolean not null default false` (additive,
idempotent, applied to prod ahead of the push like 00089/00090).

**Verification:** tsc clean (0 new; 19 pre-existing) · eslint clean · unit **213** (ab-winner 57,
flow-variants 36, ab-results-render 16, runtime 63, progress 18, graph 13, edit 10) · live-DB e2e
`e2e-ab-winner.ts` **13/13** — proves off-by-default, the campaign-default column round-trip +
inheritance, the pause write/JSONB round-trip, sender exclude/sticky, save-preserve, idempotency
(self-cleaning draft, `.invalid` emails, zero spend). Builder select + settings toggle are
tsc+eslint-verified; live visual sign-off defers to post-deploy (deep campaign route is
rAF-hang-flaky in the hidden preview — [[project_preview_pane_raf_hydration]]).

**Deploy note:** migration 00091 is live; the code is local. The column defaults false, so even
post-deploy nothing auto-pauses until someone turns it on (campaign settings or a node). Everything
below in the prior entry still applies.

---

## 2026-08-26 — A/B AUTO-WINNER: significance-test auto-pause of losing variants; LOCAL-ONLY, awaiting push

Built on top of the A/B stack below (which is itself awaiting the same push). Once a
variant gathers enough sends, a **one-sided two-proportion z-test on positive-reply rate**
auto-pauses the losers so NEW leads route to the leader. **No migration** (pause flag lives
in the graph JSONB). Living tracker: [`docs/plans/campaign-editor-roadmap.md`](docs/plans/campaign-editor-roadmap.md) §4.

### What changed (6 concerns)
1. **Pure decision** — `src/lib/flow/ab-winner.ts`: `decideAbWinner(stats, config)` (z-test;
   critical z from an Acklam probit; monotonic — only adds pauses, never pauses the leader or
   the last active variant; degenerate SE → no pause). `DEFAULT_AB_WINNER_CONFIG` = 30
   sends/variant · 60 total · 95% one-sided; per-node override via `EmailNode.ab_config`. Plus
   pure graph merges `mergePausedIntoGraph` (union new pauses) + `mergeStoredPauses` (save-route preserve).
2. **Pause storage** — `EmailNode.paused_variant_ids: string[]` (JSONB, additive, **no migration**);
   `emailVariants` annotates `ResolvedVariant.paused`; new `activeVariants` helper.
3. **Sender read-side (minimal, low deploy-risk)** — `pickVariant(node, id, {assignedId})` EXCLUDES
   paused for new leads, STICKY to a recorded assignment; a per-tick prefetch of each contact's
   first-email `variant_id` keeps a follow-up "Re:" subject on the variant they actually got. The
   sender does NO stats + NO writes — it only reads the flag.
4. **Evaluator OFF the hot-path** — `src/lib/flow/ab-winner-eval.ts` `evaluateAbWinners`, called
   from the **hourly `sync-analytics` cron** on the send log + replies it already pages (no extra
   fetch, cheap early-out unless the graph has an A/B node). Merge-safe write: re-read fresh graph →
   union pauses → persist only if grown; touches only `flow_graph`. Returns `variants_paused` in the response.
5. **Save-route preserve** — `update-sequence` re-applies stored pauses onto an incoming graph
   (`mergeStoredPauses`), so a manual builder edit can't wipe an auto-pause (a stale builder that
   loaded before the pause would otherwise clobber it).
6. **Display** — `ab-results.tsx`: Winner (trophy) + Paused (amber) + provisional Leading badges;
   `computeVariantStats` now exposes per-variant `paused` + `winnerId`/`decided`.

### Verification
tsc clean (0 new errors; 19 pre-existing) · eslint clean on touched files · unit **190**
(ab-winner 41, flow-variants 33 [+14], ab-results-render 12, runtime 63, progress 18, graph 13,
edit 10) · **live-DB e2e 10/10** (`scripts/e2e-ab-winner.ts` — real native_sends + lead_replies drive
the REAL evaluator → pause written to flow_graph + round-trips JSONB → sender pickVariant excludes/sticky
→ mergeStoredPauses preserves → idempotent second pass; self-cleaning DRAFT, `.invalid` emails, zero spend).
Display verified via static-markup render (deep campaign route is rAF-hang-flaky in the hidden preview — [[project_preview_pane_raf_hydration]]).

### Deploy risk (same gate as the stack)
Push auto-deploys, no staging. Sender change is a READ + prefetch only (flow campaigns; legacy byte-identical).
The evaluator is isolated in the hourly analytics cron — a bug there cannot stop sends. In production the
default config (30/60/0.95) means a pause only fires after real volume; low positive-reply rates mean many
campaigns never auto-pause (correct — never call a winner without evidence). Post-deploy: watch a live A/B
campaign's `sync-analytics` response for `variants_paused` once a node crosses threshold.

**Open follow-ups (not blocking):** (a) a builder "reset A/B test" affordance to manually un-pause
(today pauses are monotonic + server-owned); (b) optional per-node `ab_config` editor UI (field + eval
wired, no UI yet); (c) send-time "risky/paused last" ordering is unrelated (that's the catch-all item).

---

## 2026-08-26 — Campaign-editor stack: reply-class conditions + flow observability + A/B testing; LOCAL-ONLY, awaiting push

Three stacked builds on top of the (now-pushed) #3 graph runtime, same worktree/branch
`claude/graph-runtime-phase3`. Committed LOCAL-ONLY; **awaiting the owner's push.**
Living tracker: [`docs/plans/campaign-editor-roadmap.md`](docs/plans/campaign-editor-roadmap.md).

Owner direction this session: dropped open/click tracking as a dead end (we never add
tracking pixels/links — deliverability), so conditions/A/B/analytics all run on **inbound**
signals (replies + class, bounces). Unipile stays parked (LinkedIn = manual VA tasks).

### 1. Reply-class conditions
Flow conditions can branch on the reply's **sentiment**, not just "did they reply." New
triggers `reply_interested | reply_objection | reply_not_interested | reply_ooo` route on
`lead_replies.final_class` (sentiment groups — mapping in the roadmap doc). `replied`/`bounced`
stay; `opened`/`clicked`/`manual` **retired** from the builder (kept legacy-safe → NO branch).
Runtime `matchedReplyRoute`: a matching reply-condition stands the global reply-halt down, but
an **unhandled** reply class still halts (never re-email a replier). **No migration.**

**OOO fix (post-push, commit after the stack):** `hasReplied` (the halt signal + the plain
`replied` trigger) keys on `contact.status==='replied'` ONLY — which the reply poller sets
just for HUMAN replies (it deliberately skips out-of-office/auto-replies). An OOO still writes
a `lead_replies` row, so `replyClass='ooo'` drives `reply_ooo` (route it — e.g. wait + resume)
without halting. The earlier "contact.status OR a lead_replies row" signal wrongly halted flow
sequences on an OOO (auto-reply); linear campaigns were never affected. Runtime 63/63.

### 2. Flow observability
Read-only **"Flow progress"** view on the campaign Analytics tab: per-node live occupancy
("N here"), each condition's Yes/No branch split, and a rollup (enrolled/active/peeled/
completed/failed + reply & positive-reply rates). Derived from `current_node_id` +
`lead_replies.final_class` — **no migration**. Legacy/linear campaigns keep the linear funnel.

### 3. A/B (and C/D…) testing
`EmailNode.variants` (JSONB, backward-compatible — variant A = the node's own subject/body).
Migration **00090** = `native_sends.variant_id` (applied). The sender assigns each contact a
variant **deterministically** (even, sticky, no stored state) and stamps `variant_id`; the
Analytics tab shows a per-variant table (sent / reply / positive-reply rate) with the leader
flagged. Measured on inbound outcomes only. Builder gets an "Add variant" editor per email node.

### Verification
tsc clean · unit **96/96** (runtime 59, progress 18, variants 19) · e2e **11/11** (live DB,
self-cleaning draft) · **browser-verified**: the builder (reply-class picker + A/B editor +
honest starter) rendered live; FlowProgress + AbResults verified via SSR on a seeded draft
(real numbers — Enrolled 6/Active 4/Peeled 1, reply 33.3%/positive 16.7%; variant A 66.7%
reply vs B 0%) then cleaned up. Migrations applied: 00089 (#3), 00090 (A/B).

### Deploy risk (same gate as #3)
Push auto-deploys with no staging. Reply-class + A/B only affect **flow campaigns** (legacy
byte-identical). The sender change is small (variant pick + variant_id stamp; reply-class
routing already gated behind flow_graph). The Analytics additions are read-only. Validate
post-deploy on a controlled flow campaign.

---

## 2026-08-26 — #3 GRAPH RUNTIME built + verified + migration applied; LOCAL-ONLY, awaiting the push

The native sender now EXECUTES `campaigns.flow_graph` (branches + linkedin +
internal nodes run), not just the derived linear steps. Built in worktree
`.claude/worktrees/graph-runtime-phase3` on branch `claude/graph-runtime-phase3`.
**Committed locally, NOT pushed** — pushing rewrites how live campaigns send (no
staging); owner validates post-deploy on a controlled campaign.

### What changed
- **Migration `00089`** (APPLIED to prod 2026-08-26): `campaign_enrollments.current_node_id text`
  (nullable, additive). The enrollment's position INSIDE the graph. Legacy/linear
  campaigns (`flow_graph` NULL) ignore it and keep using `current_step_index` — zero regression.
- **`src/lib/flow/runtime.ts`** — the PURE walker `resolveFlowAction(graph, position, signals)`:
  resume after `current_node_id`, accumulate wait days, route conditions, return the
  next actionable node (email/linkedin/internal) or `complete`. Lazy re-eval each tick
  so a mid-wait reply re-routes. Unit-tested 39/39 (`scripts/test-flow-runtime.ts`).
- **`run-native-sequences/route.ts`** — a flow branch (`runFlowEnrollment`) walks the
  graph; email → shared `dispatchEmail` (the linear send block was refactored onto the
  SAME helper — one send path, no drift), linkedin → `createManualTask` (session C),
  internal → `runInternalNode` (session B). A per-tick action budget bounds side-effects.
- **`flow-editor.tsx`** — a "needs tracking" note on opened/clicked/manual conditions
  (no signal → they take the NO arm at runtime; the YES arm won't fire).

### Condition semantics (PRE-DECIDED, implemented)
- `replied` → yes iff `contact.status==='replied'` OR a `lead_replies` row (campaign+email); else no.
- `bounced` → yes iff `contact.status==='bounced'`; else no.
- `opened`/`clicked`/`manual` → **always NO** (open/link tracking off by default; no signal). Fail-safe: never peel on an unmeasurable signal; flagged in the builder.
- Global reply-halt reconciliation: on an email action, if the contact replied and NO
  replied-condition was traversed to reach it → halt (status='replied'), same as today.
  If a replied-condition governs, the walk already routed (yes arm) — no pre-empt.
- `current_step_index` keeps counting EMAILS for flow campaigns too (0=first touch), so
  the send machinery (subject/threading, new-leads cap, sticky mailbox) is unchanged.
- Pre-migration in-flight flow enrollments (current_node_id NULL, step>0) resolve their
  resume node from `current_step_index` → NO re-send.

### Verification
- tsc clean (0 new errors in touched files; the 26 remaining are the documented
  pre-existing strict-null/asset-import pages). Unit 39/39. e2e 11/11 against the LIVE DB
  on a self-cleaning DRAFT campaign (`scripts/e2e-flow-runtime.ts`): flow_graph JSONB
  round-trip, real signal read, routing both arms, real `manual_tasks` insert + flow_node
  dedup, cleanup verified (0 orphans).

### Deploy risk (the one gate)
- Push auto-deploys; the sender's per-tick behavior changes for **flow campaigns only**.
  In-flight flow enrollments will start executing previously-skipped condition/linkedin/
  internal nodes (LinkedIn tasks appear in the to-dos inbox; internal notifies fire only
  if an org enabled automations — OFF by default). Legacy/linear campaigns: byte-identical.
- Post-deploy validation: a controlled flow campaign with a branch, watch routing + tasks.

---

## 2026-08-26 — Flow builder shipped; internal-automations (B) + LinkedIn VA-tasks (C) MERGED; #3 (graph runtime) is next

### Shipped & deployed to prod (master @ `778b97c`)
- **Visual Flow campaign builder** (Instantly-style tabbed workspace + branching sequences). Model in [`src/lib/flow/graph.ts`](src/lib/flow/graph.ts) (node kinds email/wait/linkedin/internal/condition; conditions have `yes[]`/`no[]`). `graphToSteps()` derives the linear `campaign_steps` the native sender runs. Persistence: `campaigns.flow_graph` JSONB (migration `00086`, applied). Tests: graph 13/13, edit 10/10.
- **Session B — internal automations** (merged `9377535`): org notify config (`organizations.automation_settings` JSONB, migration `00087` applied) + reply-triggered Slack/webhook/email from the reply pipeline. Delivery helper: `src/lib/notifications/internal-automations.ts`; settings: `src/lib/automations/settings.ts`. **OFF by default.**
- **Session C — LinkedIn VA-tasks** (merged `f094aed`): `manual_tasks` table (migration `00088` applied, RLS + 4 policies + 6 indexes) + "LinkedIn to-dos" admin inbox + `createManualTask` helper (`src/lib/manual-tasks/create.ts`).
- `UNFAIR-ADVANTAGES.md` — self-serve strategy doc (flagship: 30-day pre-send re-verification).

> **KEY FACT:** the sender (`run-native-sequences`) still runs ONLY the derived **linear email steps**. Condition / linkedin / internal nodes are authored + persisted (and B's/C's *surfaces* are live) but the nodes **DO NOT EXECUTE** yet. #3 wires that up.

### Next — Session #3: graph-executing runtime + branch execution (migration `00089`), SOLO, autonomous
Makes `run-native-sequences` walk `flow_graph` instead of the flattened linear steps; changes `campaign_enrollments` position from `current_step_index` → a node id; executes conditions (branch), calls B's delivery helper at internal nodes and C's `createManualTask` at linkedin nodes; legacy linear campaigns unchanged. Designed to run continuously to a committed, locally-verified state, stopping ONCE for the deploy sign-off (pushing rewrites how live campaigns send; no staging).

**Paste-in kickoff prompt** (fresh worktree off master):

```
Start the graph-runtime phase (#3) of the LeadStart Flow campaign builder (Next.js 16, Supabase, native Gmail-API sender) in a FRESH worktree off master. Run this END-TO-END autonomously: work continuously in one pass, self-verify at each step, DON'T stop to ask about interim decisions and DON'T loop/wait. Stop only ONCE, at the very end, for deploy sign-off (see THE ONE GATE).

First: session-start sync (git pull origin master; confirm up to date; git log -5). Read HANDOFF.md (top entry), src/lib/flow/graph.ts, src/lib/flow/edit.ts, src/app/api/cron/run-native-sequences/route.ts, PROJECT_STATUS.md. Then read the two merged helpers you'll wire into and use their REAL signatures: src/lib/notifications/internal-automations.ts + src/lib/automations/settings.ts (session B — internal notify/webhook delivery) and src/lib/manual-tasks/create.ts (session C — createManualTask).

State: A sequence is a FlowGraph (kinds email/wait/linkedin/internal/condition; conditions have yes[]/no[]) in campaigns.flow_graph. TODAY the sender runs only the derived linear campaign_steps (graphToSteps) and ignores non-email nodes. Migrations 00086/00087/00088 are applied to prod; B & C surfaces are merged + deployed but their execution hooks are unwired.

Task — make the sender execute the flow graph (migration 00089):
1. Enrollment position: add current_node_id (+ any path state needed) to campaign_enrollments (migration 00089). Feature-detect: campaigns with flow_graph=null keep EXACT current linear behavior (current_step_index) — zero regression.
2. Rewrite run-native-sequences to walk flow_graph from each enrollment's node: email → send (unchanged mechanics: window, warmup caps, verification gate, DNC/suppression, threading, strategy ordering); wait → gate on wait_days from last_action_at; condition → evaluate + branch (see #3); linkedin → call C's createManualTask then advance; internal → call B's delivery helper for that node then advance. One node per due tick; cadence self-heals (waits measured from previous send).
3. Condition semantics (PRE-DECIDED — implement, do not ask): evaluate at the node against real signal. `replied` = contact replied (contact.status==='replied' or a lead_replies row for this campaign+contact) → yes, else no. `bounced` similarly. `opened`/`clicked` have NO reliable signal (open/link tracking OFF by default) → take the NO/continue branch (fail-safe) and flag those triggers "needs tracking" in the builder. Reconcile with the existing global reply-halt: a path with NO downstream reply-condition keeps halting on reply as today; a replied-condition routes instead of halting. Document the rules in a comment + final report.
4. Keep graphToSteps + all legacy linear campaigns behaviorally unchanged.

Verify autonomously before the gate: unit-test the graph walker as a PURE function (graph + position + reply/bounce state → next action) covering both branches of a top-level AND nested condition, wait gating, internal/linkedin side-effects, and the legacy-linear path. Then a light e2e: create a throwaway DRAFT campaign with a branched flow_graph, drive the LOCAL cron, confirm routing + a manual_tasks row is created + the internal helper would fire; then DELETE the draft. IMPORTANT: prod's Vercel cron ticks the SAME DB every 5 min with the OLD linear code — do NOT activate a test campaign prod could grab, don't trust send-count deltas, lean on unit tests. tsc must be clean.

Standing rules: LOCAL-ONLY. Apply migration 00089 via scripts/supabase-sql.mjs (Management API; SUPABASE_ACCESS_TOKEN in .env.local) AFTER a pre-flight existence check + showing the SQL; keep it additive/idempotent (ADD COLUMN IF NOT EXISTS). Commit locally, split by concern, author LeadStart <daniel@leadstart.io>. Rebase on origin/master before the gate if master moved.

THE ONE GATE: do NOT push/deploy. Pushing to master auto-deploys and this rewrites how LIVE campaigns send (no staging). When it's built, unit-verified, migration applied, and committed locally, STOP and report: what changed, your condition-semantics rules, the verification evidence, and the exact deploy risk — then wait for my explicit "push". Live validation happens post-deploy on a controlled campaign.
```

### State snapshot
- Branch `claude/campaign-builder-redesign-b4e24f`, worktree `.claude/worktrees/intelligent-wilbur-6fe08f`. HEAD = origin/master = `778b97c`, clean.
- Migrations applied to prod: `00086` (flow_graph), `00087` (automation_settings), `00088` (manual_tasks). Next free number: **`00089`** (owned by #3).
- B & C feature worktrees (`internal-automations-setup-9d84fc`, `linkedin-manual-va-tasks-6c0dd0`) are merged; safe to remove.
