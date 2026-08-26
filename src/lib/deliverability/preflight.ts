// Activation pre-flight for native email campaigns (server-only).
//
// Advisory, not a gate: when an owner/VA activates a native campaign, this
// gathers "worth a look before you go live" warnings — copy score, domain
// authentication, and the latest campaign-copy placement result. The activate
// route returns them as a 409 the first time; the user reviews them in a dialog
// and re-submits with acknowledge_warnings to proceed. It NEVER blocks (the
// hard blocks — no mailbox, no steps — stay in the route). Fail-open: any check
// that throws is skipped, never surfaced as a false problem.

import type { createAdminClient } from "@/lib/supabase/admin";
import { scoreCopy } from "./copy";
import { checkDomainAuth, domainOf } from "./check";
import type { PlacementTest } from "@/types/app";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface PreflightWarning {
  kind: "copy" | "domain_auth" | "placement" | "seeds";
  severity: "warn" | "info";
  message: string;
}

const FRESHNESS_DAYS = 7;

/**
 * Rank a placement test by how bad its outcome is — the ladder the seed_placement
 * health component uses. Higher = worse. Used to pick the single worst result
 * across a campaign's sending mailboxes.
 */
function placementRank(t: PlacementTest): number {
  const total =
    t.seeds_total || t.inbox_count + t.promotions_count + t.spam_count + t.missing_count;
  if (t.spam_count > 0 && total > 0 && t.spam_count / total >= 0.5) return 4;
  if (t.spam_count > 0) return 3;
  if (t.missing_count > 0) return 2;
  if (t.promotions_count > t.inbox_count) return 1;
  return 0;
}

/** Worst test by rank; ties break to the most recently completed. */
function worstPlacementSignal(tests: PlacementTest[]): PlacementTest | null {
  let worst: PlacementTest | null = null;
  let worstRank = -1;
  for (const t of tests) {
    const rank = placementRank(t);
    const newer =
      rank > worstRank ||
      (rank === worstRank &&
        worst != null &&
        Date.parse(t.completed_at ?? t.started_at) > Date.parse(worst.completed_at ?? worst.started_at));
    if (worst === null || newer) {
      worst = t;
      worstRank = rank;
    }
  }
  return worst;
}

export async function runActivationPreflight(
  admin: AdminClient,
  campaignId: string,
): Promise<PreflightWarning[]> {
  const warnings: PreflightWarning[] = [];
  try {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("organization_id")
      .eq("id", campaignId)
      .maybeSingle();
    const organizationId = (campaign as { organization_id: string } | null)?.organization_id;

    // ── Copy ──────────────────────────────────────────────────────────────
    try {
      const { data: stepRows } = await admin
        .from("campaign_steps")
        .select("subject_template, body_template")
        .eq("campaign_id", campaignId)
        .order("step_index", { ascending: true });
      const steps = ((stepRows ?? []) as { subject_template: string | null; body_template: string | null }[]).map(
        (s) => ({ subject: s.subject_template ?? "", body: s.body_template ?? "" }),
      );
      if (steps.length > 0) {
        const { score, issues } = scoreCopy(steps);
        if (score < 85) {
          const top = issues.slice(0, 3).map((i) => i.message);
          warnings.push({
            kind: "copy",
            severity: score < 60 ? "warn" : "info",
            message: `Copy check scored ${score}/100.${top.length ? ` ${top.join(" ")}` : ""}`,
          });
        }
      }
    } catch (err) {
      console.error("[preflight] copy check failed:", err);
    }

    // ── Domain authentication ───────────────────────────────────────────────
    try {
      const { data: pool } = await admin
        .from("campaign_mailboxes")
        .select("mailbox_id")
        .eq("campaign_id", campaignId);
      const mailboxIds = ((pool ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
      if (mailboxIds.length > 0) {
        const { data: mbs } = await admin
          .from("native_mailboxes")
          .select("email_address")
          .in("id", mailboxIds);
        const domains = [
          ...new Set(((mbs ?? []) as { email_address: string }[]).map((m) => domainOf(m.email_address))),
        ];
        const auths = await Promise.all(domains.map((d) => checkDomainAuth(d)));
        for (const a of auths) {
          const checks = [a.spf, a.dkim, a.dmarc];
          const failed = checks.filter((c) => c.status === "fail");
          const warned = checks.filter((c) => c.status === "warn");
          if (failed.length > 0) {
            warnings.push({
              kind: "domain_auth",
              severity: "warn",
              message: `${a.domain}: ${failed.map((c) => c.detail).join(" ")}`,
            });
          } else if (warned.length > 0) {
            warnings.push({
              kind: "domain_auth",
              severity: "info",
              message: `${a.domain}: ${warned.map((c) => c.detail).join(" ")}`,
            });
          }
        }
      }
    } catch (err) {
      console.error("[preflight] domain auth check failed:", err);
    }

    // ── Seeds + placement ───────────────────────────────────────────────────
    try {
      let seedCount = 0;
      if (organizationId) {
        const { count } = await admin
          .from("seed_inboxes")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("status", "active");
        seedCount = count ?? 0;
      }

      if (seedCount === 0) {
        // No panel to measure with — flag it, and don't also nag about a
        // missing placement test (same gap).
        warnings.push({
          kind: "seeds",
          severity: "info",
          message:
            "No seed inboxes are set up, so where this campaign's mail lands can't be measured. Add them under Admin → Mailboxes → Seed inboxes.",
        });
      } else {
        const sinceIso = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000).toISOString();
        const { data: testRows } = await admin
          .from("placement_tests")
          .select("*")
          .eq("campaign_id", campaignId)
          .eq("probe", "campaign")
          .eq("status", "complete")
          .gte("completed_at", sinceIso)
          .order("completed_at", { ascending: false });
        const tests = (testRows ?? []) as PlacementTest[];
        // Newest per mailbox (rows already ordered newest-first).
        const newestByMailbox = new Map<string, PlacementTest>();
        for (const t of tests) {
          if (!newestByMailbox.has(t.mailbox_id)) newestByMailbox.set(t.mailbox_id, t);
        }
        const fresh = [...newestByMailbox.values()];
        if (fresh.length === 0) {
          warnings.push({
            kind: "placement",
            severity: "info",
            message: `This campaign's copy hasn't been placement-tested in the last ${FRESHNESS_DAYS} days. A placement test from Admin → Mailboxes shows where it lands before prospects see it.`,
          });
        } else {
          const worst = worstPlacementSignal(fresh);
          if (worst && worst.spam_count > 0) {
            const total =
              worst.seeds_total ||
              worst.inbox_count + worst.promotions_count + worst.spam_count + worst.missing_count;
            const when = worst.completed_at
              ? new Date(worst.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
              : "recently";
            warnings.push({
              kind: "placement",
              severity: "warn",
              message: `The last test of this campaign's copy landed in spam on ${worst.spam_count} of ${total} seed inboxes (${when}). Run a fresh placement test from Admin → Mailboxes before going live.`,
            });
          }
        }
      }
    } catch (err) {
      console.error("[preflight] placement check failed:", err);
    }
  } catch (err) {
    // Never let the pre-flight itself block activation.
    console.error("[preflight] gather failed:", err);
  }
  return warnings;
}
