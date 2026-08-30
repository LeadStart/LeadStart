// Pure state machine for Google Workspace domain + inbox provisioning. No I/O.
// The runner (provisioning-runner.ts) attaches the Google/registrar calls; this
// module owns the shape, the step order, and the pure transitions, and is
// unit-tested like src/lib/deliverability/lifecycle.ts.
//
// Steps run strictly in order: nothing is attempted until every earlier step is
// done or skipped. A step that waits on an external clock (DNS propagation,
// verified-flag propagation, manual DKIM) stays `in_progress` and is retried
// each tick. `failed` is a permanent halt (owner-alerted; the Check-now route
// can reset it to retry).

import type {
  ProvisioningState,
  ProvisioningStep,
  ProvisioningStepId,
  ProvisioningStepStatus,
  ProvisioningUserSpec,
} from "@/types/app";

export const PROVISIONING_STEP_ORDER: ProvisioningStepId[] = [
  "dns_records",
  "workspace_domain",
  "site_verification_token",
  "site_verification",
  "users",
  "licenses",
  "mailboxes",
  "dkim",
];

export interface InitProvisioningInput {
  now: string; // ISO
  domain: string;
  users: { local_part: string; display_name: string; given_name?: string; family_name?: string }[];
  licensing: { product_id: string; sku_id: string } | null;
  dmarcRua: string | null;
}

export function initProvisioningState(input: InitProvisioningInput): ProvisioningState {
  const steps = {} as Record<ProvisioningStepId, ProvisioningStep>;
  for (const id of PROVISIONING_STEP_ORDER) {
    steps[id] = { status: "pending", attempts: 0, updated_at: input.now, last_error: null };
  }
  const users: ProvisioningUserSpec[] = input.users.map((u) => ({
    local_part: u.local_part,
    display_name: u.display_name,
    given_name: u.given_name,
    family_name: u.family_name,
    email: `${u.local_part}@${input.domain}`,
    created: false,
    licensed: false,
    mailbox_id: null,
  }));
  return {
    version: 1,
    started_at: input.now,
    updated_at: input.now,
    steps,
    site_verification_token: null,
    users,
    licensing: input.licensing,
    dmarc_rua: input.dmarcRua,
    last_error: null,
    completed_at: null,
  };
}

/** Immutably patch one step (and bump the state clock + surface its error). */
export function markStep(
  state: ProvisioningState,
  id: ProvisioningStepId,
  patch: Partial<ProvisioningStep>,
  now: string,
): ProvisioningState {
  const next: ProvisioningStep = { ...state.steps[id], ...patch, updated_at: now };
  const steps = { ...state.steps, [id]: next };
  const last_error =
    patch.last_error !== undefined ? patch.last_error : state.last_error;
  return { ...state, steps, updated_at: now, last_error };
}

/** Replace the users array (per-user progress lives there). */
export function setUsers(
  state: ProvisioningState,
  users: ProvisioningUserSpec[],
  now: string,
): ProvisioningState {
  return { ...state, users, updated_at: now };
}

export function isTerminalStatus(status: ProvisioningStepStatus): boolean {
  return status === "done" || status === "skipped" || status === "failed";
}

/** True once a step has "succeeded enough" for the next one to run. */
export function isCompleteStatus(status: ProvisioningStepStatus): boolean {
  return status === "done" || status === "skipped";
}

/** First step that isn't done/skipped (the one the runner works next), or null. */
export function firstIncompleteStep(
  state: ProvisioningState,
): ProvisioningStepId | null {
  for (const id of PROVISIONING_STEP_ORDER) {
    if (!isCompleteStatus(state.steps[id].status)) return id;
  }
  return null;
}

/** Every step done or skipped (full success). */
export function allStepsComplete(state: ProvisioningState): boolean {
  return firstIncompleteStep(state) === null;
}

/** Every step terminal (done / skipped / failed) — nothing left the runner can do. */
export function allStepsTerminal(state: ProvisioningState): boolean {
  return PROVISIONING_STEP_ORDER.every((id) =>
    isTerminalStatus(state.steps[id].status),
  );
}

/**
 * Reset failed steps back to pending and clear completed_at — the Check-now
 * force-retry. Attempts and last_error are kept for context; alerted is cleared
 * so a still-stuck step can re-alert.
 */
export function resetFailedSteps(
  state: ProvisioningState,
  now: string,
): ProvisioningState {
  let changed = false;
  const steps = { ...state.steps };
  for (const id of PROVISIONING_STEP_ORDER) {
    if (steps[id].status === "failed") {
      steps[id] = { ...steps[id], status: "pending", alerted: false, updated_at: now };
      changed = true;
    }
  }
  if (!changed && !state.completed_at) return state;
  return { ...state, steps, completed_at: null, updated_at: now };
}

/** Split a display name into given/family on the last space (family may be blank). */
export function splitDisplayName(display: string): {
  givenName: string;
  familyName: string;
} {
  const trimmed = display.trim();
  const i = trimmed.lastIndexOf(" ");
  if (i < 0) return { givenName: trimmed || "User", familyName: "-" };
  return {
    givenName: trimmed.slice(0, i).trim() || "User",
    familyName: trimmed.slice(i + 1).trim() || "-",
  };
}
