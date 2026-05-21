import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { SalesforgeClient } from "@/lib/salesforge/client";
import { registerSequenceWebhooks } from "@/lib/salesforge/webhooks";

// Same shape used by the sequences/create endpoint to build the
// webhook callback URL. Returns null when WEBHOOK_SECRET is unset so
// discovery can still insert the campaigns row without webhooks
// (operator can run /api/admin/salesforge/sequences/[id]/register-webhooks
// after the env is fixed).
function resolveWebhookUrl(): string | null {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return null;
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  const vercel = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const base = explicit || vercel || "http://localhost:3000";
  const cleanBase = base.replace(/\/$/, "");
  return `${cleanBase}/app/api/webhooks/salesforge?secret=${encodeURIComponent(secret)}`;
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Optional: sync a specific campaign
  const campaignId = request.nextUrl.searchParams.get("campaign_id");

  const { data: orgs } = await admin
    .from("organizations")
    .select("*")
    .not("salesforge_api_key", "is", null);

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ error: "No organizations with Salesforge API keys" }, { status: 400 });
  }

  let totalSynced = 0;
  let totalDiscovered = 0;
  let totalStatusUpdated = 0;

  for (const org of orgs) {
    // Walk source_channel='salesforge' campaigns and refresh their
    // analytics. Salesforge legacy does not expose step-level metrics,
    // so campaign_step_metrics rows are not written for this channel.
    if (org.salesforge_api_key && org.salesforge_workspace_id) {
      const salesforge = new SalesforgeClient(org.salesforge_api_key);
      const salesforgeWorkspaceId = org.salesforge_workspace_id;

      // ----- Discovery: pick up sequences that exist in Salesforge
      // but have no local campaigns row yet. Sequences created via
      // /admin/campaigns/new/salesforge already INSERT a row at
      // creation time; this catches sequences created directly in
      // app.salesforge.ai (the case the operator hits when migrating
      // existing campaigns or letting clients self-serve).
      //
      // Skipped on the targeted ?campaign_id= path — that mode is for
      // refreshing one known campaign's analytics, not for discovery.
      if (!campaignId) {
        try {
          const remoteSequences = await salesforge.listSequences(salesforgeWorkspaceId);
          if (remoteSequences.length > 0) {
            const remoteIds = remoteSequences.map((s) => s.id).filter(Boolean);
            const { data: existingRows } = await admin
              .from("campaigns")
              .select("id, salesforge_sequence_id, status, name")
              .eq("organization_id", org.id)
              .eq("source_channel", "salesforge")
              .in("salesforge_sequence_id", remoteIds);
            type ExistingRow = {
              id: string;
              salesforge_sequence_id: string | null;
              status: string;
              name: string;
            };
            const existingBySequenceId = new Map<string, ExistingRow>();
            for (const row of (existingRows ?? []) as ExistingRow[]) {
              if (row.salesforge_sequence_id) {
                existingBySequenceId.set(row.salesforge_sequence_id, row);
              }
            }

            // Status + name sync for known sequences. If Salesforge has
            // them as 'active' but we have 'draft' (or vice versa), the
            // analytics loop below skips them — pull updates here so the
            // next tick picks them up correctly.
            for (const seq of remoteSequences) {
              if (!seq.id) continue;
              const local = existingBySequenceId.get(seq.id);
              if (!local) continue;
              const remoteStatus =
                typeof seq.status === "string" ? seq.status : null;
              const remoteName = seq.name || null;
              const updates: Record<string, unknown> = {};
              if (remoteStatus && remoteStatus !== local.status) {
                updates.status = remoteStatus;
              }
              if (remoteName && remoteName !== local.name) {
                updates.name = remoteName;
              }
              if (Object.keys(updates).length === 0) continue;
              const { error: statusErr } = await admin
                .from("campaigns")
                .update(updates)
                .eq("id", local.id);
              if (statusErr) {
                console.error(
                  `[cron/sync-analytics] status/name update failed for ${local.id}:`,
                  statusErr,
                );
              } else {
                totalStatusUpdated++;
              }
            }

            const missing = remoteSequences.filter(
              (s) => s.id && !existingBySequenceId.has(s.id),
            );

            if (missing.length > 0) {
              const inserts = missing.map((s) => ({
                organization_id: org.id,
                client_id: null,
                salesforge_sequence_id: s.id,
                salesforge_daily_contact_cap: null, // dispatcher falls back to DEFAULT_DAILY_CAP=66
                name: s.name || `Salesforge sequence ${s.id.slice(0, 8)}`,
                status: typeof s.status === "string" ? s.status : "active",
                source_channel: "salesforge" as const,
              }));
              const { data: insertedRows, error: discoveryError } = await admin
                .from("campaigns")
                .insert(inserts)
                .select("id, salesforge_sequence_id");
              if (discoveryError) {
                console.error(
                  `[cron/sync-analytics] discovery insert failed for org ${org.id}:`,
                  discoveryError,
                );
              } else {
                totalDiscovered += insertedRows?.length ?? 0;

                // Register reply-pipeline webhooks on each newly
                // discovered sequence. Non-fatal — sequence row is
                // already written; webhooks can be re-registered
                // later via the dedicated admin endpoint.
                const callbackUrl = resolveWebhookUrl();
                if (callbackUrl) {
                  for (const row of insertedRows ?? []) {
                    const seqId = (row as { salesforge_sequence_id: string | null })
                      .salesforge_sequence_id;
                    if (!seqId) continue;
                    try {
                      await registerSequenceWebhooks({
                        client: salesforge,
                        workspaceId: salesforgeWorkspaceId,
                        sequenceId: seqId,
                      });
                    } catch (err) {
                      console.error(
                        `[cron/sync-analytics] webhook register failed for ${seqId}:`,
                        err,
                      );
                    }
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error(
            `[cron/sync-analytics] discovery threw for org ${org.id}:`,
            err,
          );
        }
      }

      let salesforgeCampaigns;
      if (campaignId) {
        const { data } = await admin
          .from("campaigns")
          .select("*")
          .eq("id", campaignId)
          .eq("organization_id", org.id)
          .eq("source_channel", "salesforge");
        salesforgeCampaigns = data || [];
      } else {
        const { data } = await admin
          .from("campaigns")
          .select("*")
          .eq("organization_id", org.id)
          .eq("source_channel", "salesforge")
          .eq("status", "active");
        salesforgeCampaigns = data || [];
      }

      for (const campaign of salesforgeCampaigns) {
        if (!campaign.salesforge_sequence_id) continue;
        try {
          const { data: lastSnapshot } = await admin
            .from("campaign_snapshots")
            .select("snapshot_date")
            .eq("campaign_id", campaign.id)
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .single();

          const startDate = lastSnapshot
            ? lastSnapshot.snapshot_date
            : new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
          const endDate = new Date().toISOString().split("T")[0];

          const analytics = await salesforge.getSequenceAnalytics(
            salesforgeWorkspaceId,
            campaign.salesforge_sequence_id,
            startDate,
            endDate,
          );

          // Salesforge returns days as an object map keyed by date
          // (e.g. {"2026-05-07": {sent, replied, ...}}), not an array.
          const days = analytics.days ?? {};
          const dateKeys = Object.keys(days);
          if (dateKeys.length === 0) continue;

          for (const dateKey of dateKeys) {
            const day = days[dateKey];
            const sent = day.sent ?? 0;
            const replies = day.replied ?? 0;
            // Salesforge's day object doesn't expose bounces/unsubs/
            // meetings per-day on the legacy analytics surface — those
            // only show up in the rollup `stats`. Default to 0 for
            // per-day rows; the stats rollup is captured implicitly
            // by the most recent day's snapshot.

            await admin.from("campaign_snapshots").upsert(
              {
                campaign_id: campaign.id,
                snapshot_date: dateKey,
                total_leads: 0,
                emails_sent: sent,
                replies,
                unique_replies: replies,
                positive_replies: 0,
                bounces: 0,
                unsubscribes: 0,
                meetings_booked: 0,
                new_leads_contacted: 0,
                reply_rate: sent > 0 ? Number(((replies / sent) * 100).toFixed(2)) : 0,
                positive_reply_rate: 0,
                bounce_rate: 0,
                unsubscribe_rate: 0,
                raw_data: day as unknown as Record<string, unknown>,
              },
              { onConflict: "campaign_id,snapshot_date" }
            );
          }

          totalSynced++;
        } catch (error) {
          console.error(`Failed to sync Salesforge campaign ${campaign.id}:`, error);
        }
      }
    }
  }

  return NextResponse.json({
    synced: totalSynced,
    discovered: totalDiscovered,
    status_updated: totalStatusUpdated,
  });
}
