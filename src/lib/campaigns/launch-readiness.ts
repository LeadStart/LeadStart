// Launch readiness for a native email campaign — what BLOCKS activation vs. what
// merely WARNS. A campaign is now created as a draft from just a name; readiness
// is how the owner sees what's still needed before it can send.
//
// Hard blockers gate the activate action (server-enforced in the activate route)
// AND disable the Launch button in the UI, using this one shared definition so
// the button and the endpoint never disagree. Soft warnings are surfaced but
// never block launching. Deliverability advisories (domain auth, placement, copy)
// stay in the separate activation pre-flight (warn-with-override) — this covers
// campaign completeness only.

import type { createAdminClient } from "@/lib/supabase/admin";

export interface ReadinessItem {
  key: string;
  label: string;
}

export interface LaunchReadiness {
  canLaunch: boolean;
  blockers: ReadinessItem[];
  warnings: ReadinessItem[];
}

export interface ReadinessInput {
  clientId: string | null;
  /** Mailboxes attached to the campaign (any status). */
  poolMailboxCount: number;
  /** Attached mailboxes that are connected/usable (native_mailboxes.status = 'active'). */
  connectedMailboxCount: number;
  stepCount: number;
  firstStepHasSubject: boolean;
  firstStepHasBody: boolean;
  /** Enrolled recipients. */
  contactCount: number;
}

// Pure readiness rule — unit-tested, no I/O.
export function computeLaunchReadiness(input: ReadinessInput): LaunchReadiness {
  const blockers: ReadinessItem[] = [];

  // Client is a hard blocker (owner decision): recipients, reply routing, and
  // billing scope all key off it.
  if (!input.clientId) {
    blockers.push({ key: "client", label: "Assign a client" });
  }

  // Copy to send.
  if (input.stepCount === 0) {
    blockers.push({ key: "steps", label: "Add at least one email step" });
  } else if (!input.firstStepHasSubject) {
    blockers.push({ key: "subject", label: "The first email needs a subject line" });
  } else if (!input.firstStepHasBody) {
    blockers.push({ key: "body", label: "The first email needs a body" });
  }

  // A connected sending mailbox.
  if (input.connectedMailboxCount === 0) {
    blockers.push({
      key: "mailbox",
      label:
        input.poolMailboxCount === 0
          ? "Add a sending mailbox"
          : "Connect a sending mailbox — none attached are connected",
    });
  }

  const warnings: ReadinessItem[] = [];
  if (input.contactCount === 0) {
    warnings.push({
      key: "contacts",
      label: "No contacts yet — the campaign will sit idle until you add some",
    });
  }

  return { canLaunch: blockers.length === 0, blockers, warnings };
}

// Gather the readiness inputs for a campaign from the DB, then compute. Shared by
// the activate route (the gate) and the campaign detail page (the badges).
export async function gatherLaunchReadiness(
  admin: ReturnType<typeof createAdminClient>,
  campaign: { id: string; client_id: string | null },
): Promise<LaunchReadiness> {
  const [poolRes, stepsRes, contactsRes] = await Promise.all([
    admin.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaign.id),
    admin
      .from("campaign_steps")
      .select("step_index, subject_template, body_template")
      .eq("campaign_id", campaign.id)
      .order("step_index", { ascending: true }),
    admin
      .from("campaign_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id),
  ]);

  const mailboxIds = ((poolRes.data ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  let connectedMailboxCount = 0;
  if (mailboxIds.length > 0) {
    const { count } = await admin
      .from("native_mailboxes")
      .select("id", { count: "exact", head: true })
      .in("id", mailboxIds)
      .eq("status", "active");
    connectedMailboxCount = count ?? 0;
  }

  const steps = (stepsRes.data ?? []) as {
    step_index: number;
    subject_template: string | null;
    body_template: string | null;
  }[];
  const first = steps.find((s) => s.step_index === 0) ?? steps[0];
  const firstStepHasSubject = Boolean(first?.subject_template && first.subject_template.trim());
  const firstStepHasBody = Boolean(first?.body_template && first.body_template.trim());

  return computeLaunchReadiness({
    clientId: campaign.client_id,
    poolMailboxCount: mailboxIds.length,
    connectedMailboxCount,
    stepCount: steps.length,
    firstStepHasSubject,
    firstStepHasBody,
    contactCount: contactsRes.count ?? 0,
  });
}
