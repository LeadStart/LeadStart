# HANDOFF — LeadStart

> Rolling session-continuity log. Newest entry on top. Roll old entries to
> `HANDOFF_ARCHIVE_<period>.md` once this passes ~60 KB.

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
