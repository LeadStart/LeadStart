// Reads one native campaign's live sending state for the engine-backed finish
// date (src/lib/planner/live.ts): the rows run-native-sequences reads each tick
// (the pool and any sticky inbox, every inbox's all-time and today's sends, the
// active enrollments, today's first emails, domain lifecycle and caps), so the
// replay starts where the dispatcher is. Read-only. Shared by the campaign
// detail page and the morning heartbeat. Throws on a failed read: a finish
// date computed from half the rows would be wrong without looking wrong.

import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRowsStrict } from "@/lib/supabase/fetch-all";
import { startOfLocalDay } from "@/lib/gmail/ramp";
import type { LiveSnapshot } from "@/lib/planner/live";

type AdminClient = ReturnType<typeof createAdminClient>;

export type LiveCampaignRow = LiveSnapshot["campaign"] & { id: string };

// Other campaigns share the dispatcher's 20-sends-per-tick budget. Their pace
// is read off the last week of sends, spread over its weekdays: it only binds
// once more than 20 inboxes are due in the same 5-minute tick.
const OTHER_SENDS_LOOKBACK_DAYS = 7;
const OTHER_SENDS_SEND_DAYS = 5;

function check<T extends { error: { message?: string } | null }>(what: string, res: T): T {
  if (res.error) throw new Error(`${what}: ${res.error.message ?? "read failed"}`);
  return res;
}

export async function loadLiveSnapshot(
  admin: AdminClient,
  campaign: LiveCampaignRow,
  now: Date = new Date(),
): Promise<LiveSnapshot> {
  const dayStartIso = new Date(startOfLocalDay(now.getTime())).toISOString();
  const lookbackIso = new Date(now.getTime() - OTHER_SENDS_LOOKBACK_DAYS * 86_400_000).toISOString();

  const [stepsRes, poolRes, enrollments, newLeadsRes, otherRes] = await Promise.all([
    admin
      .from("campaign_steps")
      .select("step_index, wait_days")
      .eq("campaign_id", campaign.id)
      .order("step_index", { ascending: true }),
    admin.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaign.id),
    fetchAllRowsStrict<LiveSnapshot["enrollments"][number]>(() =>
      admin
        .from("campaign_enrollments")
        .select("current_step_index, last_action_at, started_at, native_mailbox_id, gmail_thread_id")
        .eq("campaign_id", campaign.id)
        .eq("status", "active")
        .order("id", { ascending: true }),
    ),
    admin
      .from("native_sends")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("step_index", 0)
      .gte("sent_at", dayStartIso),
    admin
      .from("native_sends")
      .select("id", { count: "exact", head: true })
      .neq("campaign_id", campaign.id)
      .gte("sent_at", lookbackIso),
  ]);
  check("campaign_steps", stepsRes);
  check("campaign_mailboxes", poolRes);
  check("native_sends (first emails today)", newLeadsRes);
  check("native_sends (other campaigns)", otherRes);

  const poolIds = ((poolRes.data ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  const mailboxIds = [
    ...new Set([
      ...poolIds,
      ...enrollments.map((e) => e.native_mailbox_id).filter((id): id is string => !!id),
    ]),
  ];

  let mailboxes: LiveSnapshot["mailboxes"] = [];
  let sendsToday: LiveSnapshot["sendsToday"] = [];
  let domains: LiveSnapshot["domains"] = [];
  if (mailboxIds.length > 0) {
    const [mbRes, totals, today] = await Promise.all([
      admin
        .from("native_mailboxes")
        .select("id, status, max_daily_cap, daily_cap_override, ramp_baseline_sent, domain_id")
        .in("id", mailboxIds),
      // All-time sends per inbox, every campaign (route.ts totalSent): count-only.
      Promise.all(
        mailboxIds.map(async (id) => {
          const res = check(
            "native_sends (all time)",
            await admin.from("native_sends").select("id", { count: "exact", head: true }).eq("mailbox_id", id),
          );
          return [id, res.count ?? 0] as const;
        }),
      ),
      fetchAllRowsStrict<{ mailbox_id: string; sent_at: string | null }>(() =>
        admin
          .from("native_sends")
          .select("mailbox_id, sent_at")
          .in("mailbox_id", mailboxIds)
          .gte("sent_at", dayStartIso)
          .order("id", { ascending: true }),
      ),
    ]);
    check("native_mailboxes", mbRes);
    const totalById = new Map(totals);
    mailboxes = (
      (mbRes.data ?? []) as Omit<LiveSnapshot["mailboxes"][number], "total_sent">[]
    ).map((m) => ({ ...m, total_sent: totalById.get(m.id) ?? 0 }));
    sendsToday = today.filter((s): s is { mailbox_id: string; sent_at: string } => !!s.sent_at);

    const domainIds = [...new Set(mailboxes.map((m) => m.domain_id).filter((id): id is string => !!id))];
    if (domainIds.length > 0) {
      const domRes = check(
        "sending_domains",
        await admin.from("sending_domains").select("id, lifecycle_status, max_daily_sends").in("id", domainIds),
      );
      const rows = (domRes.data ?? []) as { id: string; lifecycle_status: string; max_daily_sends: number | null }[];
      // A capped domain counts every send from any of its inboxes today (route.ts domainSentToday).
      domains = await Promise.all(
        rows.map(async (d) => {
          if (d.max_daily_sends == null) return { ...d, sent_today: 0 };
          const members = check(
            "native_mailboxes (domain)",
            await admin.from("native_mailboxes").select("id").eq("domain_id", d.id),
          );
          const ids = ((members.data ?? []) as { id: string }[]).map((m) => m.id);
          if (ids.length === 0) return { ...d, sent_today: 0 };
          const sent = check(
            "native_sends (domain today)",
            await admin
              .from("native_sends")
              .select("id", { count: "exact", head: true })
              .in("mailbox_id", ids)
              .gte("sent_at", dayStartIso),
          );
          return { ...d, sent_today: sent.count ?? 0 };
        }),
      );
    }
  }

  return {
    now: now.toISOString(),
    campaign: {
      daily_new_leads_cap: campaign.daily_new_leads_cap,
      sending_strategy: campaign.sending_strategy,
      send_timezone: campaign.send_timezone,
      send_start_hour: campaign.send_start_hour,
      send_end_hour: campaign.send_end_hour,
      send_weekdays_only: campaign.send_weekdays_only,
      flow_graph: campaign.flow_graph,
    },
    waits: ((stepsRes.data ?? []) as { step_index: number; wait_days: number }[]).map((s) => s.wait_days),
    poolIds,
    mailboxes,
    sendsToday,
    newLeadsToday: newLeadsRes.count ?? 0,
    enrollments,
    domains,
    otherSendsPerDay: (otherRes.count ?? 0) / OTHER_SENDS_SEND_DAYS,
  };
}
