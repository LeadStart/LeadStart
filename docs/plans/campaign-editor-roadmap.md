# Campaign Editor Roadmap — stacked builds

> Working todo for the campaign-editor initiative. NOT app features/tasks — a
> session tracker meant to carry across sessions. Update the checkboxes as builds
> land. Newest context at the bottom of each section.

## Status legend
- [x] done  ·  [~] in progress  ·  [ ] queued

## Context — what's already shipped
- [x] **Visual Flow builder** — branching sequence editor (`src/components/campaigns/flow/`), `FlowGraph` model in `src/lib/flow/graph.ts`, persisted in `campaigns.flow_graph` (migration 00086).
- [x] **Session B** — internal automations (notify/webhook) — migration 00087. `runInternalNode`.
- [x] **Session C** — LinkedIn manual VA tasks — migration 00088. `createManualTask`.
- [x] **#3 Graph runtime** (2026-08-26, PUSHED, master `10b4483`) — the native sender executes `flow_graph` (branches + linkedin + internal). Migration 00089 = `campaign_enrollments.current_node_id`. Pure walker `src/lib/flow/runtime.ts`.

## The stack (build in this order — each depends on the previous)
These three were confirmed to stack: reply-class gives the **success metric**,
observability gives the **outcome-attribution plumbing**, A/B is the **payoff** on top.

All three built LOCAL-ONLY on branch `claude/graph-runtime-phase3`, verified, migrations
applied, awaiting the owner's push. Verification totals: **tsc clean · unit 96/96
(runtime 59, progress 18, variants 19) · e2e 11/11 · browser-verified** (builder live;
Analytics surfaces via SSR with real seeded numbers).

### 1. Reply-class conditions  [x]
Branch the flow on the reply's *sentiment*. Reads `lead_replies.final_class` — no new tracking, no migration.
- [x] `graph.ts`: triggers `reply_interested|objection|not_interested|ooo`; kept `replied`/`bounced`; retired `opened`/`clicked`/`manual` from the builder (legacy-safe); starter off the `opened` fork.
- [x] `runtime.ts`: `FlowSignals.replyClass`; sentiment mapping; `evalCondition` for reply_*; `matchedReplyRoute` safety-halt.
- [x] `run-native-sequences`: prefetch latest `final_class`; halt on `matchedReplyRoute`.
- [x] `flow-editor.tsx`: reply-class picker; "retired" note replaces "needs tracking".
- [x] Tests: unit reply-class routing + safety-halt; e2e signal shape.

**Sentiment mapping (locked):**
| Group | Classifier classes |
|---|---|
| Interested | true_interest, meeting_booked, qualifying_question, referral_forward |
| Objection | objection_price, objection_timing |
| Not interested | not_interested, wrong_person_no_referral, unsubscribe |
| Out of office | ooo |
(`needs_review` matches no group → only a plain `replied` condition catches it.)

### 2. Flow observability / outcome attribution  [x]
Read-only "Flow progress" branch view on the campaign Analytics tab. **No migration** —
derived from `current_node_id` + `lead_replies.final_class`.
- [x] `src/lib/flow/progress.ts` `computeFlowProgress` (per-node occupancy + rollup + reply/positive rates). Unit 18/18.
- [x] `flow-progress.tsx` — read-only outline with per-node "N here" + Yes/No branch splits + rollup.
- [x] Server fetch + render in the Analytics tab (flow campaigns only; legacy keeps the linear funnel).

### 3. A/B (and C/D…) testing  [x]
N-way variant testing measured on **positive-reply-rate**. Migration **00090** = `native_sends.variant_id`.
- [x] `EmailNode.variants` (JSONB, backward-compatible — variant A = the node's own subject/body).
- [x] `variants.ts` `pickVariant` — deterministic, even, sticky assignment (no stored state).
- [x] Sender picks/renders the variant + stamps `variant_id`; Re: fallback threads on the assigned first-email variant.
- [x] `variants.ts` `computeVariantStats` + `ab-results.tsx` — per-variant table, leader by positive-reply rate. Unit 19/19.
- [x] `flow-editor.tsx` — A/B variant editor on email nodes.
- [x] Winner: auto-pause-on-significance — see section 4.

### 4. A/B auto-winner (opt-in, significant + real lead)  [x]
**OFF by default, opt-in per node with a per-campaign default.** When on, a variant
is declared the winner (and losers auto-pause so NEW leads route to it) only when it
beats **every** rival on **positive-reply rate** under a rigorous rule. Pure,
unit-tested. Measured on positive-reply rate only (never opens/clicks).

**Winner rule (locked, all must hold to pause a challenger):** ≥30 sends/variant &
≥60 total (volume) · leader ≥3 positive replies (evidence) · leader leads by ≥1.0
pt (real lead) · one-sided two-proportion z-test with a **Bonferroni** correction
across live challengers (significance; 3+ variants demand a higher bar). All six
knobs are per-node-tunable; the winner is only *locked* once one variant has beaten
all others.

- [x] `src/lib/flow/ab-winner.ts` — pure `decideAbWinner(stats, config)` (z-test via an
  Acklam probit + Bonferroni; monotonic — only adds pauses, never the leader/last active;
  evidence + real-lead gates). `DEFAULT_AB_WINNER_CONFIG` = **autoPause:false** · 30/60 ·
  3 positives · 1.0pt · 95%. `resolveAbConfig(node, campaignDefault)` cascade: node override
  → campaign default → false. Pure merges `mergePausedIntoGraph` + `mergeStoredPauses`. Unit 57/57.
- [x] Opt-in storage: `EmailNode.ab_config` (JSONB — `autoPause` + threshold overrides) and
  **`campaigns.ab_auto_pause_default`** (migration **00091**, applied). `EmailNode.paused_variant_ids`
  is the server-owned pause flag; `emailVariants`→`ResolvedVariant.paused`; `activeVariants`.
- [x] `pickVariant(node, contactId, {assignedId})` — EXCLUDES paused for new assignments,
  STICKY to a recorded assignment (a lead mid-thread never re-routes).
- [x] `computeVariantStats(…, campaignDefault?)` — per-variant `paused`, leader among ACTIVE,
  `winnerId`/`decided`, effective `autoPause` (for the display).
- [x] Evaluator `src/lib/flow/ab-winner-eval.ts` `evaluateAbWinners` — runs in the **hourly
  `sync-analytics` cron** (NOT the send hot-path), off the send log + replies it already
  pages; takes the campaign default; merge-safe write. Sender only READS the flag.
- [x] `update-sequence` re-applies stored pauses onto a manual save (`mergeStoredPauses`);
  also persists `ab_auto_pause_default`.
- [x] UI: campaign-settings toggle (`campaign-detail-workspace`) + per-node tri-state select
  (Inherit / On / Off) in the builder (`flow-editor` `EmailVariants`); `ab-results.tsx` — Winner
  (trophy) + Paused (amber) + Leading badges, caption reflects on/off.
- [x] Sticky threading: sender prefetches each contact's first-email `variant_id`.
- [x] Tests: `test-ab-winner.ts` 57/57 (opt-in, evidence, real-lead, Bonferroni, cascade) +
  `test-flow-variants.ts` 36/36 + `test-ab-results-render.ts` 16/16; live-DB e2e
  `e2e-ab-winner.ts` 13/13 (off-by-default → campaign-default inherit → pause → sender read-path
  → save-preserve → idempotent; self-cleaning draft, column round-trip verified).

**Auto-winner decisions (locked):** OFF by default — opt-in per node (tri-state Inherit/On/Off)
over a per-campaign default (`ab_auto_pause_default`, migration 00091). Winner = **significant +
a real ≥1pt lead + enough evidence**, never bare significance; 3+ variants get a Bonferroni bar.
Pause is MONOTONIC + server-owned (manual "reset test" is a future add). Evaluation lives in the
analytics cron so a bug there can never stop sends.

## Decisions locked (don't relitigate)
- **No open/click tracking, ever** — no pixels, no link-wrapping (deliverability). So `opened`/`clicked` conditions are dead by design (retired from the builder), and all measurement (conditions, A/B, analytics) runs on **inbound** signals: replies (+ class), bounces.
- **Reply-halt safety:** a contact who replied is never emailed again unless a *matching* reply-class branch explicitly routes them; an unhandled reply class still halts.
- **Unipile parked** — LinkedIn stays manual VA tasks for now.
- **Push discipline:** local-only by default; every prod push is explicit (no staging).
