# HANDOFF — LeadStart

> Rolling session-continuity log. Newest entry on top. Roll old entries to
> `HANDOFF_ARCHIVE_<period>.md` once this passes ~60 KB.

---

## 2026-08-26 — Flow campaign builder SHIPPED; 3 execution phases queued (B & C running, #3 next)

### Shipped & deployed to prod (master @ `293f3ad`)
The linear campaign-builder form was replaced with a **visual Flow builder** (Instantly-style tabbed workspace + branching sequences).

- Commits: `e51b1ca` (redesign), `3d18c92` (sidebar scrollbar), `257578f` (lifecycle buttons → Launch/Pause/Resume campaign), `293f3ad` (docs).
- **Model** — [`src/lib/flow/graph.ts`](src/lib/flow/graph.ts): `FlowGraph` with node kinds **email, wait, linkedin, internal, condition** (conditions have `yes[]`/`no[]` branches). `graphToSteps()` derives the linear `campaign_steps` the native sender runs (follows every condition's `no` branch; accumulates waits across skipped nodes). Immutable tree edits in `src/lib/flow/edit.ts`. Tests: graph 13/13, edit 10/10 (`scripts/test-flow-graph.ts`, `scripts/test-flow-edit.ts`).
- **Persistence** — `campaigns.flow_graph` JSONB (**migration `00086`, APPLIED to prod**). Create route + `update-sequence` route store it; the detail page loads it (else derives a linear graph from `campaign_steps` for legacy rows).
- **UI** — tabbed workspace (Setup / Sequence / Leads / Schedule / Deliverability / Analytics), Sequence = full-height click-drag-pannable Flow canvas. Files: `src/app/(dashboard)/admin/campaigns/new/native/page.tsx`, `src/app/(dashboard)/admin/campaigns/[id]/campaign-detail-workspace.tsx` (new), `src/app/(dashboard)/admin/campaigns/[id]/page.tsx` (native → workspace), `src/components/campaigns/flow/{flow-editor.tsx,flow.module.css}` (new).
- **`UNFAIR-ADVANTAGES.md`** — strategy doc for the self-serve vision (flagship advantage: the rolling 30-day pre-send re-verification).

> **KEY FACT for the next phases:** the sender (`run-native-sequences`) executes ONLY the derived **linear email steps**. Condition / linkedin / internal nodes are **authored + persisted but DO NOT execute yet.** Verified end-to-end: create/load/edit of a branched graph round-trips and keeps the derived steps in sync (throwaway-draft test, then deleted).

### In-flight — 3 execution phases (parallel lane split)
All three ultimately need the sender to **walk `flow_graph`** instead of the flattened linear steps. That shared runtime is the merge-conflict hotspot: `src/app/api/cron/run-native-sequences/route.ts` + the `campaign_enrollments` position model (`current_step_index`) + `flow_graph` execution semantics. So they DON'T cleanly parallelize; #3 is the foundation the other two's execution hooks plug into.

- **Session B (RUNNING now):** internal-automations config + reply-triggered notify. Migration **`00087`**. Slack/webhook/notify-target settings + wire notify into the existing reply pipeline (`src/lib/replies/pipeline.ts`). Leaves a delivery helper + a TODO for inline-node execution. Must NOT touch the sender / enrollment model.
- **Session C (RUNNING now):** LinkedIn-manual VA-task inbox. Migration **`00088`**. A `manual_tasks` table + VA task-inbox UI + API + an exported `createManualTask` helper (TODO: called by the runtime later). Must NOT touch the sender / enrollment model.
- **Session #3 (NEXT — solo, starts AFTER B & C merge to master):** the graph-executing runtime + branch execution. Migration **`00089`**. Kickoff prompt below.

### State snapshot
- Branch `claude/campaign-builder-redesign-b4e24f`, worktree `.claude/worktrees/intelligent-wilbur-6fe08f`. HEAD = origin/master = `293f3ad`, clean, 0 ahead / 0 behind.
- Dev preview ran on `:3000` (native Gmail app) during this session.
- Prod change made outside code: **migration `00086`** (flow_graph column) — live, harmless (deployed-then old code ignored it; new code uses it).
- Lanes: this initiative owns the campaign builder + sender path. B owns `00087` + internal-automation surfaces; C owns `00088` + VA-task surfaces; #3 owns `00089` + the sender/enrollment rewrite. Hand out migration numbers so they don't collide.

### Next pickup — Session #3 kickoff prompt (paste into a FRESH worktree AFTER B & C merge)

```
I'm starting the graph-runtime phase (#3) of the LeadStart Flow campaign builder (Next.js 16, Supabase, native Gmail-API sender). Work in a FRESH worktree off master. First run the session-start sync from CLAUDE.md (git pull origin master, confirm up to date, git log -5). Then read: HANDOFF.md (top entry), src/lib/flow/graph.ts, src/lib/flow/edit.ts, src/app/api/cron/run-native-sequences/route.ts, src/app/api/admin/campaigns/[id]/update-sequence/route.ts, and PROJECT_STATUS.md.

Where things stand: The visual Flow builder is shipped. A sequence is a FlowGraph (node kinds email, wait, linkedin, internal, condition; conditions have yes[]/no[] branches) persisted in campaigns.flow_graph. TODAY the sender runs ONLY the derived linear campaign_steps (graphToSteps) and ignores every non-email node — conditions, linkedin, internal DO NOT execute. Two parallel sessions should have landed their surfaces on master:
- Session B: internal-automations config + a delivery helper (Slack/webhook/notify). Migration 00087.
- Session C: LinkedIn-manual VA-task inbox + an exported createManualTask helper. Migration 00088.
FIRST verify B and C are merged to master and READ their actual code — exact helper names/signatures + table schemas — and wire into their REAL code, not assumptions. If either isn't merged, stop and tell me.

Your task — make the sender execute the flow graph (migration 00089):
1. Change enrollment position from the linear current_step_index to a position IN the graph (node id / path) on campaign_enrollments; feature-detect flow_graph so legacy linear campaigns (flow_graph null) behave exactly as today.
2. Rewrite the run-native-sequences dispatch loop to walk flow_graph from each enrollment's position: email → send (as now); wait → gate; condition → evaluate the trigger and take yes/no; linkedin → call C's createManualTask then advance; internal → call B's delivery helper then advance. Preserve everything already correct (send window, warmup caps, verification gate, DNC/suppression, threading, strategy ordering).
3. Define precisely what condition triggers evaluate against (replied via lead_replies/contact.status; "opened" is tricky since open-tracking is off by default — likely gate/flag it or treat as manual). Confirm the semantics with me before building.

Standing rules: LOCAL-ONLY by default — no commit/push without my explicit word; pushing to master AUTO-DEPLOYS to prod (no staging). Apply migrations via scripts/supabase-sql.mjs (Management API; SUPABASE_ACCESS_TOKEN in .env.local) AFTER showing me the SQL + a pre-flight check. This changes how LIVE campaigns send — verify hard (unit-test the graph walker; drive a throwaway draft end-to-end, then delete it) before anything nears prod. Rebase on origin/master before any push (B & C moved files).

Acceptance: a branched draft walks correctly — replier peels to the yes branch, non-repliers continue the no branch; an internal node fires B's helper; a linkedin node creates a C task; legacy linear campaigns send exactly as before. Give me a short plan before building.
```
