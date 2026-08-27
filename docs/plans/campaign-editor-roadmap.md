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

### 4. A/B auto-winner (significance-test auto-pause)  [x]
Once a variant has gathered enough sends, a one-sided two-proportion **z-test on
positive-reply rate** pauses the losers so NEW leads route to the leader. Pure,
unit-tested decision + a runtime pause flag stored in the graph JSONB (**no
migration**). Measured on positive-reply rate only (never opens/clicks).
- [x] `src/lib/flow/ab-winner.ts` — pure `decideAbWinner(stats, config)` (z-test via an
  Acklam probit; monotonic — only ever adds pauses; never pauses the leader/last active),
  `DEFAULT_AB_WINNER_CONFIG` (30 sends/variant · 60 total · 95% one-sided), per-node
  override via `EmailNode.ab_config`, plus pure graph merges `mergePausedIntoGraph`
  (evaluator) + `mergeStoredPauses` (save-route preserve). Unit 41/41.
- [x] `EmailNode.paused_variant_ids` (JSONB) — server-owned pause flag; `emailVariants`
  annotates `ResolvedVariant.paused`; `activeVariants` helper.
- [x] `pickVariant(node, contactId, {assignedId})` — EXCLUDES paused for new assignments,
  STICKY to a recorded assignment (a lead mid-thread never re-routes).
- [x] `computeVariantStats` — per-variant `paused`, leader among ACTIVE, `winnerId`/`decided`.
- [x] Evaluator `src/lib/flow/ab-winner-eval.ts` `evaluateAbWinners` — runs in the **hourly
  `sync-analytics` cron** (NOT the send hot-path), off the send log + replies it already
  pages; merge-safe write (re-read → union → persist only if grown). Sender only READS the flag.
- [x] `update-sequence` route re-applies stored pauses onto a manual save (`mergeStoredPauses`)
  so a builder edit can't wipe an auto-pause.
- [x] `ab-results.tsx` — Winner (trophy) + Paused (amber) + provisional Leading badges.
- [x] Sticky threading: sender prefetches each contact's recorded first-email `variant_id`
  so a follow-up "Re:" subject can't flip when a variant is paused mid-thread.
- [x] Tests: unit `test-ab-winner.ts` 41/41 + `test-flow-variants.ts` +14 (33/33) +
  `test-ab-results-render.ts` 12/12; live-DB e2e `e2e-ab-winner.ts` 10/10 (real
  sends/replies → real evaluator → pause in JSONB → sender read-path → save-preserve →
  idempotent; self-cleaning draft).

**Auto-winner decisions (locked):** significance only (never a bare threshold) — a slow
market simply never triggers a pause, which is correct; pause is MONOTONIC + server-owned
(a manual "reset test" affordance is a future add, not accidental un-pause); evaluation
lives in the analytics cron so a bug there can never stop sends.

## Decisions locked (don't relitigate)
- **No open/click tracking, ever** — no pixels, no link-wrapping (deliverability). So `opened`/`clicked` conditions are dead by design (retired from the builder), and all measurement (conditions, A/B, analytics) runs on **inbound** signals: replies (+ class), bounces.
- **Reply-halt safety:** a contact who replied is never emailed again unless a *matching* reply-class branch explicitly routes them; an unhandled reply class still halts.
- **Unipile parked** — LinkedIn stays manual VA tasks for now.
- **Push discipline:** local-only by default; every prod push is explicit (no staging).
