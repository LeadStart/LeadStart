// createManualTask — the server-side hook the future "graph runtime" calls to
// drop a LinkedIn manual VA task into the queue. NOTHING calls it yet; this
// session builds the table + inbox + API and exports this helper so the runtime
// can wire it up without reshaping anything. Do NOT execute linkedin nodes in
// the native sender until that session ships (see the TODO block below).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowLinkedInKind } from "@/lib/flow/graph";
import type { ManualTaskKind } from "@/types/app";

/** Map a FlowGraph linkedin node's `li_kind` to the manual_tasks.kind value. */
export function manualTaskKindForLinkedIn(li_kind: FlowLinkedInKind): ManualTaskKind {
  return li_kind === "message" ? "linkedin_message" : "linkedin_connect";
}

export interface CreateManualTaskInput {
  organizationId: string;
  campaignId: string;
  contactId: string;
  kind: ManualTaskKind;
  /** The message/note the VA sends, already token-rendered by the caller. */
  renderedBody: string;
  /** The client the campaign belongs to — denormalized so the inbox can show it. */
  clientId?: string | null;
  /** The FlowGraph node id. SET THIS for runtime dedup (one task per node per contact). */
  flowNodeId?: string | null;
  /** Pre-assign to a profile (optional). */
  assignee?: string | null;
  /** The profile creating the task; null for the cron / graph runtime. */
  createdBy?: string | null;
}

export interface CreateManualTaskResult {
  id: string | null;
  /** false when a duplicate was swallowed by the flow_node dedup guard. */
  created: boolean;
  error: string | null;
}

/**
 * Insert an OPEN manual VA task. Requires a SERVICE-ROLE client
 * (`createAdminClient()`) — the caller is trusted server code that has already
 * resolved the org; RLS is not relied on here.
 *
 * Idempotent when `flowNodeId` is set: a duplicate (campaign, contact, flow_node)
 * trips the `idx_manual_tasks_flow_node_unique` partial index and is swallowed
 * (returns `{ created: false }`), so a runtime that re-reaches the same node for
 * the same contact never double-queues it.
 *
 * ┌─ TODO(graph-runtime) ───────────────────────────────────────────────────────┐
 * │ This is the hook the separate "graph runtime" session wires up. When the     │
 * │ graph executor reaches a FlowGraph `linkedin` node for an enrolled contact,  │
 * │ it should render the node body and call this helper — roughly:               │
 * │                                                                              │
 * │   import { renderTemplate } from "@/lib/native/render"; // token substitution │
 * │   const kind = manualTaskKindForLinkedIn(node.li_kind);                      │
 * │   await createManualTask(admin, {                                            │
 * │     organizationId, campaignId, contactId: contact.id, kind,                 │
 * │     renderedBody: renderTemplate(node.body, contact),                        │
 * │     clientId: campaign.client_id, flowNodeId: node.id,                       │
 * │   });                                                                        │
 * │                                                                              │
 * │ Intended call site: src/app/api/cron/run-native-sequences/route.ts — which   │
 * │ this session deliberately did NOT touch. Until then, linkedin nodes are      │
 * │ skipped by the sender (see graphToSteps in src/lib/flow/graph.ts) and no     │
 * │ manual_tasks rows are ever created.                                          │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */
export async function createManualTask(
  admin: SupabaseClient,
  input: CreateManualTaskInput,
): Promise<CreateManualTaskResult> {
  const row = {
    organization_id: input.organizationId,
    campaign_id: input.campaignId,
    contact_id: input.contactId,
    client_id: input.clientId ?? null,
    kind: input.kind,
    flow_node_id: input.flowNodeId ?? null,
    rendered_body: input.renderedBody ?? "",
    assignee: input.assignee ?? null,
    created_by: input.createdBy ?? null,
    status: "open" as const,
  };

  const { data, error } = await admin
    .from("manual_tasks")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation: a task for this (campaign, contact, flow node)
    // already exists — the idempotency guard doing its job, not a failure.
    if ((error as { code?: string }).code === "23505") {
      return { id: null, created: false, error: null };
    }
    return { id: null, created: false, error: error.message };
  }
  return { id: (data as { id: string } | null)?.id ?? null, created: true, error: null };
}
