// GET /api/cron/sync-analytics
//
// Hourly analytics roll-up for the native email channel. The native channel has
// no external analytics surface, so we build per-day `campaign_snapshots` rows
// from the local send log (`native_sends`) + reply pipeline (`lead_replies`).
// These are the same rows the client portal + KPI calculator already render, so
// a native campaign just starts showing real numbers.
//
// (Until 2026-07 this cron also discovered Salesforge sequences and pulled their
// analytics over the Salesforge API. That channel was disconnected and its half
// of this route removed — it now reads only local tables, no vendor key needed.)

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { HOT_REPLY_CLASSES, type ReplyClass } from "@/types/app";

// Force dynamic rendering on every invocation. Without this, a Vercel cron
// (which hits the same URL with no query params) can receive an edge-cached
// response from a prior tick, skipping the function body entirely — the DB is
// never touched but the route returns the old payload. Applied to every cron
// route preemptively after the 2026-05-27 edge-cache incident.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Optional: refresh a single campaign regardless of status.
  const campaignId = request.nextUrl.searchParams.get("campaign_id");

  let totalNativeSynced = 0;

  // ----- Native email analytics -----
  // Roll our own per-day snapshots from the local send log + reply pipeline.
  // These write the SAME campaign_snapshots rows the client portal + KPI
  // calculator already render, so no portal changes are needed.
  {
    let nativeQuery = admin
      .from("campaigns")
      .select("id")
      .eq("source_channel", "native_email");
    // ?campaign_id= refreshes one campaign regardless of status; otherwise only
    // active campaigns are synced.
    nativeQuery = campaignId
      ? nativeQuery.eq("id", campaignId)
      : nativeQuery.eq("status", "active");
    const { data: nativeCampaigns } = await nativeQuery;

    for (const nc of (nativeCampaigns ?? []) as { id: string }[]) {
      try {
        // PostgREST caps a response at 1000 rows, so page through the send log
        // + replies (a full campaign can exceed 1000 sends).
        type SendRow = { sent_at: string | null; status: string; step_index: number };
        const sends: SendRow[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await admin
            .from("native_sends")
            .select("sent_at, status, step_index")
            .eq("campaign_id", nc.id)
            .order("id", { ascending: true })
            .range(from, from + 999);
          if (error) throw error;
          const rows = (data ?? []) as SendRow[];
          sends.push(...rows);
          if (rows.length < 1000) break;
        }

        type ReplyRow = { received_at: string | null; final_class: string | null; lead_email: string | null };
        const replies: ReplyRow[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await admin
            .from("lead_replies")
            .select("received_at, final_class, lead_email")
            .eq("campaign_id", nc.id)
            .eq("source_channel", "native_email")
            .eq("excluded_from_stats", false) // excluded leads don't count
            .order("id", { ascending: true })
            .range(from, from + 999);
          if (error) throw error;
          const rows = (data ?? []) as ReplyRow[];
          replies.push(...rows);
          if (rows.length < 1000) break;
        }

        // Bucket both streams by UTC day. Sends run in the ET business window
        // (12:00–22:00 UTC), so a send's UTC day == its ET day; replies can
        // arrive any hour, but day-granularity chart buckets tolerate that.
        type DayBucket = {
          sent: number; bounces: number; newLeads: number;
          replies: number; positive: number; unsub: number; meetings: number;
          repliers: Set<string>;
        };
        const byDay = new Map<string, DayBucket>();
        const bucket = (d: string): DayBucket => {
          let b = byDay.get(d);
          if (!b) {
            b = { sent: 0, bounces: 0, newLeads: 0, replies: 0, positive: 0, unsub: 0, meetings: 0, repliers: new Set() };
            byDay.set(d, b);
          }
          return b;
        };

        for (const s of sends) {
          if (!s.sent_at) continue;
          const b = bucket(s.sent_at.slice(0, 10));
          b.sent++;                              // a bounced email was still sent
          if (s.status === "bounced") b.bounces++;
          if (s.step_index === 0) b.newLeads++;  // step 0 == first touch for a lead
        }
        for (const r of replies) {
          if (!r.received_at) continue;
          const b = bucket(r.received_at.slice(0, 10));
          b.replies++;
          if (r.lead_email) b.repliers.add(r.lead_email.toLowerCase());
          if (r.final_class && HOT_REPLY_CLASSES.includes(r.final_class as ReplyClass)) b.positive++;
          if (r.final_class === "unsubscribe") b.unsub++;
          if (r.final_class === "meeting_booked") b.meetings++;
        }

        if (byDay.size > 0) {
          const rows = [...byDay.entries()].map(([snapshot_date, b]) => {
            const uniqueReplies = b.repliers.size || b.replies;
            return {
              campaign_id: nc.id,
              snapshot_date,
              total_leads: 0,
              emails_sent: b.sent,
              replies: b.replies,
              unique_replies: uniqueReplies,
              positive_replies: b.positive,
              bounces: b.bounces,
              unsubscribes: b.unsub,
              meetings_booked: b.meetings,
              new_leads_contacted: b.newLeads,
              reply_rate: b.sent > 0 ? Number(((uniqueReplies / b.sent) * 100).toFixed(2)) : 0,
              positive_reply_rate: uniqueReplies > 0 ? Number(((b.positive / uniqueReplies) * 100).toFixed(2)) : 0,
              bounce_rate: b.sent > 0 ? Number(((b.bounces / b.sent) * 100).toFixed(2)) : 0,
              unsubscribe_rate: b.sent > 0 ? Number(((b.unsub / b.sent) * 100).toFixed(2)) : 0,
            };
          });
          const { error: upsertErr } = await admin
            .from("campaign_snapshots")
            .upsert(rows, { onConflict: "campaign_id,snapshot_date" });
          if (upsertErr) throw upsertErr;
        }
        totalNativeSynced++;
      } catch (err) {
        console.error(`[cron/sync-analytics] native snapshot sync failed for ${nc.id}:`, err);
      }
    }
  }

  return NextResponse.json({ native_synced: totalNativeSynced });
}
