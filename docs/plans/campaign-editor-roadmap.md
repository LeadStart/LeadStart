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
- [ ] Winner: auto-promote-on-significance (future — manual pick / leader-flag ships now).

## Decisions locked (don't relitigate)
- **No open/click tracking, ever** — no pixels, no link-wrapping (deliverability). So `opened`/`clicked` conditions are dead by design (retired from the builder), and all measurement (conditions, A/B, analytics) runs on **inbound** signals: replies (+ class), bounces.
- **Reply-halt safety:** a contact who replied is never emailed again unless a *matching* reply-class branch explicitly routes them; an unhandled reply class still halts.
- **Unipile parked** — LinkedIn stays manual VA tasks for now.
- **Push discipline:** local-only by default; every prod push is explicit (no staging).
