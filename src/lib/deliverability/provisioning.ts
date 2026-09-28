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
  SendingDomain,
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

/** Owner-facing step names (the stepper UI and route error messages). */
export const PROVISIONING_STEP_LABELS: Record<ProvisioningStepId, string> = {
  dns_records: "DNS records",
  workspace_domain: "Add domain to Workspace",
  site_verification_token: "Get verification token",
  site_verification: "Verify domain ownership",
  users: "Create inboxes",
  licenses: "Assign licenses",
  mailboxes: "Register mailboxes",
  dkim: "DKIM authentication",
};

/** Hard cap on inboxes per sending domain (owner rule, 2026-09-27): scale by
 *  adding domains, never by stacking inboxes on one. Enforced on every path
 *  that adds an inbox: Workspace provisioning and "Connect an existing inbox". */
export const MAX_INBOXES_PER_DOMAIN = 3;

/** The steps that set up the DOMAIN itself, as opposed to its inboxes. */
export const DOMAIN_SETUP_STEPS: ProvisioningStepId[] = [
  "dns_records",
  "workspace_domain",
  "site_verification_token",
  "site_verification",
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

export interface InitAddInboxesInput extends InitProvisioningInput {
  /** The domain's previous run, if any. Its verification token and DMARC rua
   *  carry forward so the DNS panel keeps listing the records the domain has. */
  previous: ProvisioningState | null;
  /** The Directory reported the domain on this Workspace AND verified, checked
   *  live when the run starts. When false the verification steps still run. */
  domainVerified: boolean;
  /** Keep watching for DKIM (the domain is still in provisioning and only
   *  starts sending once DKIM lands); otherwise the step is skipped. */
  watchDkim: boolean;
}

/**
 * State for adding inboxes to a domain that is already set up. Same shape and
 * runner as a first setup, but the domain-level work is pre-completed: DNS is
 * never rewritten (the domain's row has Rewrite DNS for repairs), the domain is
 * already on the Workspace (the caller checked live), and verification is done
 * when the Directory says so. Only users, licenses, mailboxes and, for a domain
 * still in provisioning, DKIM run. Pre-completed steps keep attempts at 0,
 * which is how the stepper tells them apart from steps this run worked.
 */
export function initAddInboxesState(input: InitAddInboxesInput): ProvisioningState {
  const base = initProvisioningState({
    ...input,
    dmarcRua: input.previous?.dmarc_rua ?? input.dmarcRua,
  });
  let state: ProvisioningState = {
    ...base,
    kind: "add_inboxes",
    site_verification_token: input.previous?.site_verification_token ?? null,
  };
  state = markStep(state, "dns_records", { status: "skipped" }, input.now);
  state = markStep(state, "workspace_domain", { status: "done" }, input.now);
  if (input.domainVerified) {
    state = markStep(state, "site_verification_token", { status: "done" }, input.now);
    state = markStep(state, "site_verification", { status: "done" }, input.now);
  }
  if (!input.watchDkim) {
    state = markStep(state, "dkim", { status: "skipped" }, input.now);
  }
  return state;
}

export type InboxSetupEligibility =
  | { ok: true; mode: "setup" | "add_inboxes" }
  | { ok: false; reason: string };

/**
 * Can this domain get new inboxes right now, and through which kind of run?
 *   setup        a tracked or bought domain whose first setup never started
 *   add_inboxes  a domain that is already set up: its last run finished (or
 *                only DKIM is still pending), or a backfilled warming/active
 *                domain that never went through the flow at all
 * A run still working (or halted on a failure), a domain rotated out of
 * service (tired, resting, burned, retired) and a domain already holding
 * MAX_INBOXES_PER_DOMAIN inboxes are refused with an owner-facing reason. Pure:
 * the wizard uses it to list domains, the workspace route as the authoritative
 * check (with the live inbox count).
 */
export function inboxSetupEligibility(
  domain: Pick<SendingDomain, "tier" | "lifecycle_status" | "provisioning">,
  inboxCount = 0,
): InboxSetupEligibility {
  if (domain.tier !== "gmail") {
    return { ok: false, reason: "Inboxes can only be created on Google (Gmail-tier) domains." };
  }
  switch (domain.lifecycle_status) {
    case "tired":
      return { ok: false, reason: "This domain is tired: it takes no new leads while it drains, so it doesn't get new inboxes." };
    case "resting":
      return { ok: false, reason: "This domain is resting to let its reputation recover. It can get new inboxes once it re-warms." };
    case "burned":
      return { ok: false, reason: "This domain is burned and is never reused." };
    case "retired":
      return { ok: false, reason: "This domain is retired." };
  }

  const run = domain.provisioning;
  let mode: "setup" | "add_inboxes";
  if (!run) {
    mode = domain.lifecycle_status === "provisioning" ? "setup" : "add_inboxes";
  } else {
    const blocker = firstIncompleteStep(run);
    if (blocker !== null && blocker !== "dkim") {
      const label = PROVISIONING_STEP_LABELS[blocker];
      if (run.steps[blocker].status === "failed") {
        return {
          ok: false,
          reason: `Setup for this domain stopped at "${label}". Fix that and use Check now on the domain's row, then add inboxes.`,
        };
      }
      return { ok: false, reason: `Setup for this domain is still running ("${label}"). Add more inboxes once it finishes.` };
    }
    mode = "add_inboxes";
  }
  if (inboxCount >= MAX_INBOXES_PER_DOMAIN) {
    return {
      ok: false,
      reason: `Full: ${inboxCount} inboxes, and a domain holds at most ${MAX_INBOXES_PER_DOMAIN}. Add another domain for more sending capacity.`,
    };
  }
  return { ok: true, mode };
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

/** Every step terminal (done / skipped / failed): nothing left the runner can do. */
export function allStepsTerminal(state: ProvisioningState): boolean {
  return PROVISIONING_STEP_ORDER.every((id) =>
    isTerminalStatus(state.steps[id].status),
  );
}

/**
 * Reset failed steps back to pending and clear completed_at: the Check-now
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
