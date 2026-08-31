// The impure half of Workspace provisioning: attaches the Google / registrar /
// Gmail calls to the pure state machine in provisioning.ts and advances a
// domain as far as it can this tick. Shared by the provisioning cron and the
// "Check now" route so both behave identically.
//
// Contract: each step is observe-then-act and idempotent (409/412 = already
// done). Steps run strictly in order — the loop stops at the first step that
// stays `in_progress` (waiting on an external clock) or `failed` (permanent),
// because later steps depend on it. Passwords are returned once (revealed) and
// never persisted.

import { randomBytes } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { ProvisioningState, ProvisioningStepId, SendingDomain } from "@/types/app";
import type { WorkspaceAdminClients } from "@/lib/google/org";
import type { RegistrarProvider } from "@/lib/registrar/types";
import type { GmailClient } from "@/lib/gmail/client";
import type { DomainAuth } from "@/lib/deliverability/check";
import { gmailTierRecords } from "@/lib/registrar/dns";
import { DEFAULT_MAX_DAILY_CAP } from "@/lib/gmail/ramp";
import {
  GoogleAuthError,
  GoogleConfigError,
  GooglePermanentError,
  GoogleRateLimitError,
  GoogleTransientError,
} from "@/lib/google/auth";
import {
  firstIncompleteStep,
  isCompleteStatus,
  markStep,
  resetFailedSteps,
  setUsers,
  splitDisplayName,
} from "./provisioning";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface AdvanceDeps {
  admin: AdminClient;
  /** null = manual registrar → DNS steps become owner copy-paste (skipped here). */
  registrar: RegistrarProvider | null;
  workspace: WorkspaceAdminClients;
  gmail: GmailClient;
  /** Injected so tests can stub the live DNS probe. */
  checkAuth: (domain: string) => Promise<DomainAuth>;
  /** Injected clock (ISO). Defaults to the wall clock. */
  now?: () => string;
}

export interface AdvanceResult {
  state: ProvisioningState;
  advanced: ProvisioningStepId[];
  revealed_passwords: { email: string; password: string }[];
  became_warming: boolean;
}

/** Retryable (keep in_progress) vs permanent (fail). Unknown/registrar/network → retry. */
function isPermanent(err: unknown): boolean {
  if (err instanceof GoogleRateLimitError || err instanceof GoogleTransientError) {
    return false;
  }
  return (
    err instanceof GoogleAuthError ||
    err instanceof GooglePermanentError ||
    err instanceof GoogleConfigError
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function genPassword(): string {
  return randomBytes(18).toString("base64url"); // 24 url-safe chars
}

/** Display name for a registrar id, used in owner-facing step messages. */
function registrarLabel(id: string): string {
  if (id === "porkbun") return "Porkbun";
  if (id === "spaceship") return "Spaceship";
  return id;
}

/**
 * Actionable message for the site-verification wait, instead of Google's raw
 * "400: verification token could not be found". It names what's actually
 * missing (the google-site-verification TXT in DNS) and what to do about it,
 * tailored to whether a registrar can write DNS for this domain.
 */
function verificationWaitHint(domain: SendingDomain): string {
  const base =
    "Not verified yet: Google can't find this domain's google-site-verification TXT record in DNS.";
  if (domain.registrar === "porkbun" || domain.registrar === "spaceship") {
    const label = registrarLabel(domain.registrar);
    return (
      `${base} Open "DNS records" below and use "Retry DNS" to write it ` +
      `(needs the ${label} API key saved in Settings, API). If it was just written, ` +
      `allow a few minutes for DNS to propagate.`
    );
  }
  return (
    `${base} Add the verification TXT shown under "DNS records" below at your DNS host, ` +
    `then "Check now". If it was just added, allow a few minutes for DNS to propagate.`
  );
}

/**
 * Advance one provisioning domain as far as it can this tick. Mutates the DB
 * (sending_domains.provisioning via CAS, native_mailboxes on the mailboxes
 * step, and the provisioning→warming flip when DKIM lands) and returns the new
 * state plus any one-time passwords to surface.
 */
export async function advanceProvisioning(
  deps: AdvanceDeps,
  domain: SendingDomain,
  opts?: { resetFailed?: boolean },
): Promise<AdvanceResult> {
  if (!domain.provisioning) {
    throw new Error(`Domain ${domain.domain} has no provisioning state.`);
  }
  const nowFn = deps.now ?? (() => new Date().toISOString());
  // CAS token is the loaded clock; an in-memory reset below does not change it,
  // so the final write still targets the row we read.
  const casToken = domain.provisioning.updated_at;

  // Check-now force-retry: pull any failed step back to pending first.
  let state = opts?.resetFailed
    ? resetFailedSteps(domain.provisioning, nowFn())
    : domain.provisioning;
  const advanced: ProvisioningStepId[] = [];
  const revealed: { email: string; password: string }[] = [];
  let becameWarming = false;

  // Bounded loop: at most one pass per step.
  for (let guard = 0; guard <= 8; guard++) {
    const id = firstIncompleteStep(state);
    if (!id) break; // all done/skipped
    if (state.steps[id].status === "failed") break; // permanent halt

    const nowIso = nowFn();
    const outcome = await runStep(id, state, domain, deps, nowIso);
    state = outcome.state;
    if (outcome.revealed) revealed.push(...outcome.revealed);
    if (outcome.becameWarming) becameWarming = true;
    advanced.push(id);

    // Stop if this step didn't complete — later steps depend on it.
    if (!isCompleteStatus(state.steps[id].status)) break;
  }

  // Mark the run complete when nothing actionable remains (all done/skipped, or
  // a permanent failure halted it). The cron then stops selecting this row;
  // Check-now can still force a re-run.
  const blocker = firstIncompleteStep(state);
  const halted =
    blocker === null || state.steps[blocker].status === "failed";
  if (halted && !state.completed_at) {
    const nowIso = nowFn();
    state = { ...state, completed_at: nowIso, updated_at: nowIso };
  }

  // Persist with a compare-and-set on the JSONB's own clock (the row's
  // updated_at is bumped hourly by the health rollup, so it can't be the token).
  await deps.admin
    .from("sending_domains")
    .update({ provisioning: state })
    .eq("id", domain.id)
    .eq("provisioning->>updated_at", casToken);

  return { state, advanced, revealed_passwords: revealed, became_warming: becameWarming };
}

interface StepOutcome {
  state: ProvisioningState;
  revealed?: { email: string; password: string }[];
  becameWarming?: boolean;
}

async function runStep(
  id: ProvisioningStepId,
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
): Promise<StepOutcome> {
  const bump = state.steps[id].attempts + 1;

  switch (id) {
    case "dns_records":
      return dnsRecordsStep(state, domain, deps, now, bump);
    case "workspace_domain":
      return workspaceDomainStep(state, domain, deps, now, bump);
    case "site_verification_token":
      return siteVerificationTokenStep(state, domain, deps, now, bump);
    case "site_verification":
      return siteVerificationStep(state, domain, deps, now, bump);
    case "users":
      return usersStep(state, domain, deps, now, bump);
    case "licenses":
      return licensesStep(state, domain, deps, now, bump);
    case "mailboxes":
      return mailboxesStep(state, domain, deps, now, bump);
    case "dkim":
      return dkimStep(state, domain, deps, now, bump);
  }
}

async function dnsRecordsStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  if (!deps.registrar) {
    if (domain.registrar === "porkbun" || domain.registrar === "spaceship") {
      // A registrar IS chosen for this domain but no API client could be built,
      // which means its API key isn't saved. Silently skipping here is exactly
      // what leaves the google-site-verification TXT unwritten and makes the
      // later site-verification step fail with an opaque Google 400. Stop at DNS
      // with an actionable message instead of failing three steps downstream.
      const label = registrarLabel(domain.registrar);
      return {
        state: markStep(
          state,
          "dns_records",
          {
            status: "failed",
            attempts,
            last_error:
              `${label} is set as this domain's registrar, but no ${label} API key is saved, ` +
              `so its DNS records (including Google's verification TXT) can't be written. Add the ` +
              `${label} API key in Settings, API, then use "Retry DNS".`,
          },
          now,
        ),
      };
    }
    // Manual registrar: the owner writes DNS by copy-paste (surfaced by the
    // GET dns route). Nothing for us to do here.
    return { state: markStep(state, "dns_records", { status: "skipped", attempts, last_error: null }, now) };
  }
  try {
    await deps.registrar.upsertDnsRecords(
      domain.domain,
      gmailTierRecords({ dmarcRua: state.dmarc_rua ?? undefined }),
    );
    return { state: markStep(state, "dns_records", { status: "done", attempts, last_error: null }, now) };
  } catch (err) {
    // DNS writes are retryable — a registrar hiccup shouldn't be terminal.
    return { state: markStep(state, "dns_records", { status: "in_progress", attempts, last_error: msg(err) }, now) };
  }
}

async function workspaceDomainStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  try {
    await deps.workspace.directory.insertDomain(domain.domain);
    return { state: markStep(state, "workspace_domain", { status: "done", attempts, last_error: null }, now) };
  } catch (err) {
    const status = isPermanent(err) ? "failed" : "in_progress";
    return { state: markStep(state, "workspace_domain", { status, attempts, last_error: msg(err) }, now) };
  }
}

async function siteVerificationTokenStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  try {
    const token =
      state.site_verification_token ??
      (await deps.workspace.siteVerification.getDnsToken(domain.domain));
    let next: ProvisioningState = { ...state, site_verification_token: token };
    // Write the verification TXT via the registrar (manual → owner copy-pastes).
    if (deps.registrar) {
      await deps.registrar.upsertDnsRecords(domain.domain, [
        { type: "TXT", name: "", content: token },
      ]);
    }
    next = markStep(next, "site_verification_token", { status: "done", attempts, last_error: null }, now);
    return { state: next };
  } catch (err) {
    const status = isPermanent(err) ? "failed" : "in_progress";
    return { state: markStep(state, "site_verification_token", { status, attempts, last_error: msg(err) }, now) };
  }
}

async function siteVerificationStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  try {
    const v = await deps.workspace.siteVerification.verifyDomain(domain.domain);
    if (!v.verified) {
      // TXT not visible to Google yet. Surface an actionable hint (what's
      // missing + what to do) rather than Google's raw "token not found" 400.
      return { state: markStep(state, "site_verification", { status: "in_progress", attempts, last_error: verificationWaitHint(domain) }, now) };
    }
    const d = await deps.workspace.directory.getDomain(domain.domain);
    if (d.verified) {
      return { state: markStep(state, "site_verification", { status: "done", attempts, last_error: null }, now) };
    }
    // Verified at the Site Verification API, but the Workspace Directory hasn't
    // flipped its verified flag yet. Usually a short propagation lag; if it
    // persists, verifying the domain in the Google Admin console forces it.
    return {
      state: markStep(
        state,
        "site_verification",
        {
          status: "in_progress",
          attempts,
          last_error:
            `Google confirmed the DNS token; Workspace is finalizing verification for ${domain.domain}. ` +
            "This completes automatically — usually within minutes, occasionally up to a couple hours on " +
            "Google's side. No action needed.",
        },
        now,
      ),
    };
  } catch (err) {
    const status = isPermanent(err) ? "failed" : "in_progress";
    return { state: markStep(state, "site_verification", { status, attempts, last_error: msg(err) }, now) };
  }
}

async function usersStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  const users = state.users.map((u) => ({ ...u }));
  const revealed: { email: string; password: string }[] = [];
  let permanentError: string | null = null;

  for (const u of users) {
    if (u.created) continue;
    const split = splitDisplayName(u.display_name);
    const givenName = u.given_name?.trim() || split.givenName;
    const familyName = u.family_name?.trim() || split.familyName;
    const password = genPassword();
    try {
      const res = await deps.workspace.directory.insertUser({
        primaryEmail: u.email,
        givenName,
        familyName,
        password,
      });
      u.created = true;
      // Only surface a password we actually just set (a 409-resume didn't).
      if (res.created) revealed.push({ email: u.email, password });
    } catch (err) {
      if (isPermanent(err)) {
        permanentError = msg(err);
        break;
      }
      // Transient (e.g. domain-not-verified propagation window) — retry next tick.
    }
  }

  let next = setUsers(state, users, now);
  const allCreated = users.every((u) => u.created);
  if (permanentError) {
    next = markStep(next, "users", { status: "failed", attempts, last_error: permanentError }, now);
  } else if (allCreated) {
    next = markStep(next, "users", { status: "done", attempts, last_error: null }, now);
  } else {
    next = markStep(next, "users", { status: "in_progress", attempts, last_error: "Waiting on user creation." }, now);
  }
  return { state: next, revealed };
}

async function licensesStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  const lic = state.licensing;
  if (!lic) {
    // No SKU configured → the tenant auto-licenses; nothing to assign.
    return { state: markStep(state, "licenses", { status: "skipped", attempts, last_error: null }, now) };
  }
  const users = state.users.map((u) => ({ ...u }));
  let permanentError: string | null = null;

  for (const u of users) {
    if (!u.created || u.licensed) continue;
    try {
      await deps.workspace.licensing.assignLicense(lic.product_id, lic.sku_id, u.email);
      u.licensed = true;
    } catch (err) {
      if (isPermanent(err)) {
        permanentError = msg(err);
        break;
      }
    }
  }

  let next = setUsers(state, users, now);
  const allLicensed = users.filter((u) => u.created).every((u) => u.licensed);
  if (permanentError) {
    next = markStep(next, "licenses", { status: "failed", attempts, last_error: permanentError }, now);
  } else if (allLicensed) {
    next = markStep(next, "licenses", { status: "done", attempts, last_error: null }, now);
  } else {
    next = markStep(next, "licenses", { status: "in_progress", attempts, last_error: "Waiting on license assignment." }, now);
  }
  return { state: next };
}

async function mailboxesStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  const users = state.users.map((u) => ({ ...u }));

  for (const u of users) {
    if (!u.created || u.mailbox_id) continue;
    try {
      // Confirm the mailbox is live (DWD round-trip) — can 404 for minutes
      // after user creation (eventual consistency).
      await deps.gmail.getProfile(u.email);
    } catch {
      continue; // not ready yet — retry next tick
    }
    const { data, error } = await deps.admin
      .from("native_mailboxes")
      .insert({
        organization_id: domain.organization_id,
        email_address: u.email,
        domain_id: domain.id,
        display_name: u.display_name || null,
        max_daily_cap: DEFAULT_MAX_DAILY_CAP,
      })
      .select("id")
      .single();
    if (data?.id) {
      u.mailbox_id = data.id as string;
    } else if (error?.code === "23505") {
      // Already registered — adopt the existing row.
      const { data: existing } = await deps.admin
        .from("native_mailboxes")
        .select("id")
        .eq("organization_id", domain.organization_id)
        .eq("email_address", u.email)
        .maybeSingle();
      if (existing?.id) u.mailbox_id = existing.id as string;
    }
  }

  let next = setUsers(state, users, now);
  const allLinked = users.filter((u) => u.created).every((u) => u.mailbox_id);
  next = markStep(
    next,
    "mailboxes",
    allLinked
      ? { status: "done", attempts, last_error: null }
      : { status: "in_progress", attempts, last_error: "Waiting on mailboxes to become live." },
    now,
  );
  return { state: next };
}

async function dkimStep(
  state: ProvisioningState,
  domain: SendingDomain,
  deps: AdvanceDeps,
  now: string,
  attempts: number,
): Promise<StepOutcome> {
  let auth: DomainAuth;
  try {
    auth = await deps.checkAuth(domain.domain);
  } catch (err) {
    return { state: markStep(state, "dkim", { status: "in_progress", attempts, last_error: msg(err) }, now) };
  }
  if (auth.dkim.status !== "pass") {
    return {
      state: markStep(
        state,
        "dkim",
        { status: "in_progress", attempts, last_error: "Awaiting DKIM. Generate it in Google Admin, then it's detected automatically." },
        now,
      ),
    };
  }
  // DKIM is live. Stamp the fact and flip the domain into warming. Both writes
  // are guarded so they can only advance, never stomp a later state.
  await deps.admin
    .from("sending_domains")
    .update({
      dkim_verified_at: now,
      lifecycle_status: "warming",
      lifecycle_changed_at: now,
    })
    .eq("id", domain.id)
    .eq("lifecycle_status", "provisioning");
  return {
    state: markStep(state, "dkim", { status: "done", attempts, last_error: null }, now),
    becameWarming: true,
  };
}
