# HANDOFF — LeadStart

> Rolling session-continuity log. Newest entry on top. Roll old entries to
> `HANDOFF_ARCHIVE_<period>.md` once this passes ~60 KB.

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
