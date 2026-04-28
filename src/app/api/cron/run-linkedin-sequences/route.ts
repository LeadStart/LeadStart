// GET /api/cron/run-linkedin-sequences
//
// Sequence engine tick. Every run:
//   1. Pull a batch of campaign_enrollments where status='active' and the
//      current step's wait_days has elapsed since last_action_at (or, on
//      step 0, the enrollment was just created).
//   2. For each, dispatch via Unipile by step.kind.
//   3. Update last_action_at + bump current_step_index, or mark
//      'completed' / 'failed' as appropriate.
//
// Throttling: per-account caps (80 connection requests/week, 150 messages
// /day) protect connected LinkedIn accounts from automation flags. Counts
// come from campaign_enrollments.last_action_at scoped to the account.
//
// Out of scope for v0: inmail (needs Sales Nav + subject), like_post,
// profile_visit. Encountering any of these marks the enrollment as
// 'failed' with last_error set so the operator sees it in the UI.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { UnipileClient } from "@/lib/unipile/client";
import type {
  CampaignEnrollment,
  CampaignStep,
  Contact,
  SequenceStepKind,
} from "@/types/app";

export const maxDuration = 60;

// Per-tick limit. Each dispatch is ~500-1500ms (Unipile call + retry
// backoff possible) so 30 enrollments uses up to ~45s — safely under
// Vercel's 60s budget.
const ENROLLMENTS_PER_TICK = 30;

// Per-account safety caps (LinkedIn enforces ~100 connections/wk hard).
const CAP_CONNECT_PER_WEEK = 80;
const CAP_MESSAGE_PER_DAY = 150;

type EnrollmentRow = CampaignEnrollment;
type CampaignRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  status: string;
  source_channel: string;
  unipile_account_id: string | null;
  name: string;
};
type OrgRow = { id: string; unipile_api_key: string | null; unipile_dsn: string | null };

interface DispatchContext {
  unipile: UnipileClient;
  accountId: string;
  enrollment: EnrollmentRow;
  step: CampaignStep;
  contact: Contact;
}

interface DispatchResult {
  ok: boolean;
  error?: string;
  unipile_chat_id?: string;
  unipile_invitation_id?: string;
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Pull a batch of active enrollments, oldest last_action_at first so a
  // backlog drains predictably. Secondary sort on created_at gives newly
  // enrolled rows a fair chance even when the last_action_at NULLs sort
  // low.
  const { data: enrollmentsData, error: enrError } = await admin
    .from("campaign_enrollments")
    .select("*")
    .eq("status", "active")
    .order("last_action_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(ENROLLMENTS_PER_TICK * 3); // overfetch — many will be filtered out by wait_days

  if (enrError) {
    console.error("[cron/linkedin-sequences] enrollment fetch failed:", enrError);
    return NextResponse.json({ error: enrError.message }, { status: 500 });
  }

  const enrollments = (enrollmentsData ?? []) as EnrollmentRow[];
  if (enrollments.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  // Per-account dispatch counter — both for the per-account safety cap
  // and so the per-tick budget can fall back to per-account fairness.
  const dispatchCounts: Record<string, { connect: number; message: number }> = {};

  // Fetch campaigns + orgs + accounts for the batch in bulk so we don't
  // round-trip per enrollment.
  const campaignIds = [...new Set(enrollments.map((e) => e.campaign_id))];
  const { data: campaignsData } = await admin
    .from("campaigns")
    .select(
      "id, organization_id, client_id, status, source_channel, unipile_account_id, name",
    )
    .in("id", campaignIds);
  const campaignMap = new Map<string, CampaignRow>();
  for (const c of (campaignsData ?? []) as CampaignRow[]) {
    campaignMap.set(c.id, c);
  }

  const orgIds = [
    ...new Set(
      Array.from(campaignMap.values()).map((c) => c.organization_id),
    ),
  ];
  const { data: orgsData } = await admin
    .from("organizations")
    .select("id, unipile_api_key, unipile_dsn")
    .in("id", orgIds);
  const orgMap = new Map<string, OrgRow>();
  for (const o of (orgsData ?? []) as OrgRow[]) {
    orgMap.set(o.id, o);
  }

  let dispatched = 0;
  const results: Array<{ enrollment_id: string; result: string }> = [];

  for (const enrollment of enrollments) {
    if (dispatched >= ENROLLMENTS_PER_TICK) break;

    const campaign = campaignMap.get(enrollment.campaign_id);
    if (!campaign) continue;
    if (campaign.status !== "active" || campaign.source_channel !== "linkedin") {
      // Campaign paused/archived or not a LinkedIn campaign — skip silently.
      continue;
    }

    const accountId = campaign.unipile_account_id;
    if (!accountId) {
      await markEnrollmentFailed(
        admin,
        enrollment.id,
        "Campaign has no Unipile account binding.",
      );
      results.push({ enrollment_id: enrollment.id, result: "failed_no_account" });
      continue;
    }

    const org = orgMap.get(campaign.organization_id);
    if (!org?.unipile_api_key || !org?.unipile_dsn) {
      await markEnrollmentFailed(
        admin,
        enrollment.id,
        "Organization is missing Unipile credentials.",
      );
      results.push({ enrollment_id: enrollment.id, result: "failed_no_creds" });
      continue;
    }

    // Fetch the current step. We do this per-enrollment because
    // (campaign_id, step_index) isn't bulkable cleanly — only ~30 lookups
    // per tick so the cost is acceptable.
    const { data: stepData } = await admin
      .from("campaign_steps")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("step_index", enrollment.current_step_index)
      .maybeSingle();
    const step = stepData as CampaignStep | null;

    if (!step) {
      // No step at the current index = sequence is complete.
      await admin
        .from("campaign_enrollments")
        .update({ status: "completed" })
        .eq("id", enrollment.id);
      results.push({ enrollment_id: enrollment.id, result: "completed" });
      continue;
    }

    // wait_days gate — for step 0 we use started_at, otherwise last_action_at.
    const referenceTime = enrollment.last_action_at ?? enrollment.started_at;
    if (step.wait_days > 0 && referenceTime) {
      const dueAt = new Date(
        new Date(referenceTime).getTime() + step.wait_days * 86400000,
      );
      if (Date.now() < dueAt.getTime()) {
        // Not due yet; skip silently.
        continue;
      }
    }

    // Resolve the contact.
    const { data: contactData } = await admin
      .from("contacts")
      .select("*")
      .eq("id", enrollment.contact_id)
      .maybeSingle();
    const contact = contactData as Contact | null;
    if (!contact) {
      await markEnrollmentFailed(
        admin,
        enrollment.id,
        "Contact no longer exists.",
      );
      results.push({ enrollment_id: enrollment.id, result: "failed_no_contact" });
      continue;
    }

    // Per-account safety cap.
    const counters = dispatchCounts[accountId] ?? { connect: 0, message: 0 };
    if (step.kind === "connect_request") {
      const weekCount = await countActions(admin, accountId, "connect_request", 7);
      if (weekCount + counters.connect >= CAP_CONNECT_PER_WEEK) {
        results.push({
          enrollment_id: enrollment.id,
          result: "throttled_connect_weekly",
        });
        continue;
      }
    } else if (step.kind === "message" || step.kind === "inmail") {
      const dayCount = await countActions(admin, accountId, "message", 1);
      if (dayCount + counters.message >= CAP_MESSAGE_PER_DAY) {
        results.push({
          enrollment_id: enrollment.id,
          result: "throttled_message_daily",
        });
        continue;
      }
    }

    const unipile = new UnipileClient(org.unipile_api_key, org.unipile_dsn);
    let result: DispatchResult;
    try {
      result = await dispatchStep({
        unipile,
        accountId,
        enrollment,
        step,
        contact,
      });
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!result.ok) {
      await markEnrollmentFailed(
        admin,
        enrollment.id,
        result.error ?? "Dispatch failed",
      );
      results.push({ enrollment_id: enrollment.id, result: "failed_dispatch" });
      continue;
    }

    // Success: bump step + last_action_at; carry chat/invitation refs forward.
    const nextIndex = enrollment.current_step_index + 1;
    const update: Record<string, unknown> = {
      current_step_index: nextIndex,
      last_action_at: new Date().toISOString(),
      last_error: null,
    };
    if (result.unipile_chat_id) update.unipile_chat_id = result.unipile_chat_id;
    if (result.unipile_invitation_id)
      update.unipile_invitation_id = result.unipile_invitation_id;

    // Check if there's a next step; mark completed if not.
    const { data: nextStep } = await admin
      .from("campaign_steps")
      .select("id")
      .eq("campaign_id", campaign.id)
      .eq("step_index", nextIndex)
      .maybeSingle();
    if (!nextStep) update.status = "completed";

    await admin
      .from("campaign_enrollments")
      .update(update)
      .eq("id", enrollment.id);

    if (step.kind === "connect_request") counters.connect++;
    else counters.message++;
    dispatchCounts[accountId] = counters;
    dispatched++;
    results.push({
      enrollment_id: enrollment.id,
      result: nextStep ? "advanced" : "completed",
    });
  }

  return NextResponse.json({
    status: "ok",
    dispatched,
    results,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Dispatch one step via Unipile. Returns ok=true with chat/invitation refs
// when the call succeeded; ok=false + error when it didn't.
async function dispatchStep(ctx: DispatchContext): Promise<DispatchResult> {
  const { unipile, accountId, enrollment, step, contact } = ctx;
  const body = renderTemplate(step.body_template ?? "", contact);
  const providerId = extractProviderId(contact.linkedin_url);

  switch (step.kind) {
    case "connect_request": {
      if (!providerId) {
        return { ok: false, error: "Contact has no LinkedIn URL." };
      }
      const res = await unipile.sendInvitation({
        account_id: accountId,
        provider_id: providerId,
        message: body || undefined,
      });
      return { ok: true, unipile_invitation_id: res.invitation_id };
    }
    case "message": {
      if (!body) {
        return { ok: false, error: "Message body is empty." };
      }
      // First message in the sequence opens a chat; subsequent messages
      // reuse enrollment.unipile_chat_id.
      if (enrollment.unipile_chat_id) {
        await unipile.sendMessage({
          chat_id: enrollment.unipile_chat_id,
          text: body,
        });
        return { ok: true, unipile_chat_id: enrollment.unipile_chat_id };
      }
      if (!providerId) {
        return { ok: false, error: "Contact has no LinkedIn URL for new chat." };
      }
      const res = await unipile.startNewChat({
        account_id: accountId,
        attendees_ids: [providerId],
        text: body,
      });
      return { ok: true, unipile_chat_id: res.chat_id };
    }
    case "inmail":
    case "like_post":
    case "profile_visit":
      return {
        ok: false,
        error: `Step kind '${step.kind}' not yet supported by the sequence engine.`,
      };
    default: {
      // Exhaustiveness check — TS will complain if SequenceStepKind grows
      // and this default is missed.
      const _exhaustive: SequenceStepKind = step.kind;
      return { ok: false, error: `Unknown step kind: ${_exhaustive}` };
    }
  }
}

// {{first_name}} / {{last_name}} / {{company}} / {{title}} merge.
function renderTemplate(template: string, contact: Contact): string {
  return template
    .replaceAll("{{first_name}}", contact.first_name ?? "")
    .replaceAll("{{last_name}}", contact.last_name ?? "")
    .replaceAll("{{company}}", contact.company_name ?? "")
    .replaceAll("{{title}}", contact.title ?? "")
    .trim();
}

// Vanity URL handle. linkedin.com/in/<handle>/ → <handle>. Unipile accepts
// the vanity handle as provider_id for sendInvitation / startNewChat.
function extractProviderId(linkedinUrl: string | null): string | null {
  if (!linkedinUrl) return null;
  const m = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : null;
}

// Per-account dispatch count over a recent window. Uses
// campaign_enrollments.last_action_at as a proxy for "did we send something
// from this account around then" — joined with campaigns to filter to a
// single account's activity. Approximate but cheap.
async function countActions(
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  kind: "connect_request" | "message",
  windowDays: number,
): Promise<number> {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  // We can't easily distinguish kinds from last_action_at alone; this
  // counts ALL actions on the account in the window. Conservative — caps
  // both metrics against the smaller of the two limits when a campaign
  // mixes kinds. Fine for v0; can split with a dispatch_log table later.
  void kind;
  const { count } = await admin
    .from("campaign_enrollments")
    .select("id, campaigns!inner(unipile_account_id)", {
      count: "exact",
      head: true,
    })
    .eq("campaigns.unipile_account_id", accountId)
    .gte("last_action_at", since);
  return count ?? 0;
}

async function markEnrollmentFailed(
  admin: ReturnType<typeof createAdminClient>,
  enrollmentId: string,
  reason: string,
): Promise<void> {
  await admin
    .from("campaign_enrollments")
    .update({ status: "failed", last_error: reason })
    .eq("id", enrollmentId);
}
