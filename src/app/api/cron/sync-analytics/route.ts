import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { SalesforgeClient } from "@/lib/salesforge/client";
import { registerSequenceWebhooks } from "@/lib/salesforge/webhooks";
import { HOT_REPLY_CLASSES, type ReplyClass } from "@/types/app";

// Force dynamic rendering on every invocation. Without this, a Vercel cron
// (which hits the same URL with no query params) can receive an edge-cached
// response from a prior tick, skipping the function body entirely — the DB
// is never touched but the route returns the old payload. Caught on
// 2026-05-27 in /api/cron/dispatch-salesforge-enrollments (commit 59b8745);
// applying the same guard to every cron route preemptively.
export const dynamic = "force-dynamic";

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
  let totalContactsSynced = 0;
  let totalContactsLinked = 0;
  let totalNativeSynced = 0;

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
                        callbackUrl,
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

      // ----- Contact sync: pull every contact in the Salesforge workspace
      // and reconcile against LeadStart's contacts table. Salesforge has
      // no GET /sequences/{id}/contacts, but it does expose a
      // not_in_sequence_id filter on the workspace contacts endpoint —
      // so for each LeadStart campaign with a sequence id, we compute
      // sequence membership by set diff (all workspace contacts MINUS
      // those not-in-this-sequence = those IN this sequence).
      //
      // Skipped on ?campaign_id= (that mode is for refreshing one
      // campaign's analytics, not a full contact reconcile).
      if (!campaignId) {
        try {
          const allWorkspaceContacts = await salesforge.listAllWorkspaceContacts(
            salesforgeWorkspaceId,
          );
          if (allWorkspaceContacts.length > 0) {
            const now = new Date().toISOString();
            // Filter to contacts with usable emails.
            const usable = allWorkspaceContacts.filter(
              (c) => c.email && c.email.includes("@"),
            );

            // Pre-fetch existing local contacts by lower(email) so we
            // don't trip the contacts unique index (which is on
            // lower(email) — supabase-js can't onConflict a functional
            // index). Split into INSERT vs UPDATE based on existence.
            const lowerEmails = usable.map((c) => c.email!.trim().toLowerCase());
            const { data: existingLocal } = await admin
              .from("contacts")
              .select("id, email")
              .eq("organization_id", org.id)
              .in("email", lowerEmails);
            // Fallback search using case-insensitive matches — the
            // contacts table may have stored emails in mixed case
            // historically. Re-scan with the raw emails so we don't
            // accidentally double-insert a row whose stored email
            // differs only in case.
            const rawEmails = usable.map((c) => c.email!.trim());
            const { data: existingLocalCase } = await admin
              .from("contacts")
              .select("id, email")
              .eq("organization_id", org.id)
              .in("email", rawEmails);
            const existingByEmail = new Map<string, string>();
            for (const row of [
              ...((existingLocal ?? []) as { id: string; email: string }[]),
              ...((existingLocalCase ?? []) as { id: string; email: string }[]),
            ]) {
              existingByEmail.set(row.email.toLowerCase(), row.id);
            }

            const toInsert: typeof usable = [];
            const toUpdate: { localId: string; sf: typeof usable[number] }[] = [];
            for (const c of usable) {
              const localId = existingByEmail.get(c.email!.trim().toLowerCase());
              if (localId) {
                toUpdate.push({ localId, sf: c });
              } else {
                toInsert.push(c);
              }
            }

            if (toInsert.length > 0) {
              const insertPayload = toInsert.map((c) => ({
                id: crypto.randomUUID(),
                organization_id: org.id,
                client_id: null,
                campaign_id: null,
                email: c.email!.trim(),
                salesforge_contact_id: c.id,
                first_name: c.firstName ?? null,
                last_name: c.lastName ?? null,
                company_name: c.company ?? null,
                linkedin_url: c.linkedinUrl ?? null,
                tags: c.tags ?? [],
                status: "uploaded",
                source: "salesforge-sync",
                created_at: now,
                updated_at: now,
              }));
              const { error: insertErr } = await admin
                .from("contacts")
                .insert(insertPayload);
              if (insertErr) {
                console.error(
                  `[cron/sync-analytics] contact insert failed for org ${org.id}:`,
                  insertErr,
                );
              } else {
                totalContactsSynced += insertPayload.length;
              }
            }

            if (toUpdate.length > 0) {
              // Update each row individually — different rows get
              // different field values. Could batch with a CTE but
              // the count is bounded by workspace size (typically
              // <10k); per-row UPDATE is fine.
              for (const { localId, sf } of toUpdate) {
                const patch: Record<string, unknown> = {
                  salesforge_contact_id: sf.id,
                  status: "uploaded",
                  source: "salesforge-sync",
                  updated_at: now,
                };
                if (sf.firstName) patch.first_name = sf.firstName;
                if (sf.lastName) patch.last_name = sf.lastName;
                if (sf.company) patch.company_name = sf.company;
                if (sf.linkedinUrl) patch.linkedin_url = sf.linkedinUrl;
                if (sf.tags && sf.tags.length > 0) patch.tags = sf.tags;
                const { error: updErr } = await admin
                  .from("contacts")
                  .update(patch)
                  .eq("id", localId);
                if (updErr) {
                  console.error(
                    `[cron/sync-analytics] contact update failed for ${localId}:`,
                    updErr,
                  );
                } else {
                  totalContactsSynced++;
                }
              }
            }

            // Per-campaign sequence-membership reconcile. For each
            // Salesforge campaign in the org, ask Salesforge which
            // workspace contacts are NOT in this sequence; the diff
            // against the workspace total is the truth for "currently
            // enrolled". Link contacts that ARE in the sequence to the
            // campaign, unlink local rows that aren't.
            //
            // The previous "auto-link all workspace contacts when org
            // has one Salesforge campaign" rule was a hack — it ignored
            // sequence membership and would re-link rows the operator
            // had just unlinked. Trusting the API's not_in_sequence_id
            // filter is honest and reversible.
            //
            // Use a separate query that includes draft + paused campaigns
            // (salesforgeCampaigns above is filtered to status='active'
            // because that's what analytics sync wants, but reconcile
            // needs to run for every Salesforge campaign regardless).
            const { data: allOrgCampaigns } = await admin
              .from("campaigns")
              .select("id, client_id, salesforge_sequence_id")
              .eq("organization_id", org.id)
              .eq("source_channel", "salesforge")
              .not("salesforge_sequence_id", "is", null);
            const reconcileCampaigns = (allOrgCampaigns ?? []) as {
              id: string;
              client_id: string | null;
              salesforge_sequence_id: string | null;
            }[];
            const workspaceSfIdSet = new Set(usable.map((c) => c.id));
            for (const campaign of reconcileCampaigns) {
              if (!campaign.salesforge_sequence_id) continue;
              try {
                const notInSeq = await salesforge.listAllWorkspaceContacts(
                  salesforgeWorkspaceId,
                  { notInSequenceId: campaign.salesforge_sequence_id },
                );
                const notInSeqIdSet = new Set(notInSeq.map((c) => c.id));
                const inSeqIds = [...workspaceSfIdSet].filter(
                  (id) => !notInSeqIdSet.has(id),
                );

                // Link in-sequence Salesforge contacts to this campaign.
                if (inSeqIds.length > 0) {
                  const chunkSize = 500;
                  for (let i = 0; i < inSeqIds.length; i += chunkSize) {
                    const chunk = inSeqIds.slice(i, i + chunkSize);
                    const { count: linkedCount, error: linkErr } = await admin
                      .from("contacts")
                      .update(
                        {
                          campaign_id: campaign.id,
                          client_id: campaign.client_id,
                          updated_at: now,
                        },
                        { count: "exact" },
                      )
                      .eq("organization_id", org.id)
                      .in("salesforge_contact_id", chunk)
                      .or(`campaign_id.is.null,campaign_id.neq.${campaign.id}`);
                    if (linkErr) {
                      console.error(
                        `[cron/sync-analytics] sequence-link failed for ${campaign.id}:`,
                        linkErr,
                      );
                    } else {
                      totalContactsLinked += linkedCount ?? 0;
                    }
                  }
                }

                // Unlink local rows on this campaign whose Salesforge
                // contact id is NOT in the in-sequence set (removed
                // from sequence assignment OR from workspace entirely).
                //
                // EXCEPT: contacts with a pending salesforge_enrollment_queue
                // row for this campaign are protected. They were just
                // imported and the dispatcher hasn't pushed them yet, so
                // Salesforge legitimately doesn't have them in the
                // sequence — don't undo the operator's intent mid-flight.
                const inSeqIdSet = new Set(inSeqIds);
                const { data: linkedHere } = await admin
                  .from("contacts")
                  .select("id, salesforge_contact_id")
                  .eq("campaign_id", campaign.id)
                  .not("salesforge_contact_id", "is", null);
                const { data: pendingQueueRows } = await admin
                  .from("salesforge_enrollment_queue")
                  .select("contact_id")
                  .eq("campaign_id", campaign.id)
                  .eq("status", "pending");
                const pendingContactIds = new Set(
                  ((pendingQueueRows ?? []) as { contact_id: string }[]).map(
                    (r) => r.contact_id,
                  ),
                );
                const orphanIds = ((linkedHere ?? []) as {
                  id: string;
                  salesforge_contact_id: string | null;
                }[])
                  .filter(
                    (r) =>
                      r.salesforge_contact_id &&
                      !inSeqIdSet.has(r.salesforge_contact_id) &&
                      !pendingContactIds.has(r.id),
                  )
                  .map((r) => r.id);
                if (orphanIds.length > 0) {
                  const chunkSize = 500;
                  for (let i = 0; i < orphanIds.length; i += chunkSize) {
                    const chunk = orphanIds.slice(i, i + chunkSize);
                    await admin
                      .from("contacts")
                      .update({ campaign_id: null, updated_at: now })
                      .in("id", chunk);
                  }
                }
              } catch (err) {
                console.error(
                  `[cron/sync-analytics] sequence-membership reconcile failed for ${campaign.id}:`,
                  err,
                );
              }
            }
          }
        } catch (err) {
          console.error(
            `[cron/sync-analytics] workspace contact sync threw for org ${org.id}:`,
            err,
          );
        }
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

  // ----- Native email analytics -----
  // Salesforge exposes analytics via its API; the native email channel has no
  // external analytics surface, so we roll our own per-day snapshots from the
  // local send log + reply pipeline. These write the SAME campaign_snapshots
  // rows the client portal + KPI calculator already render, so no portal
  // changes are needed — a native campaign just starts showing real numbers.
  //
  // Runs independently of the Salesforge org loop above (all inputs are local
  // tables, no API key needed). It does sit after the "no Salesforge orgs"
  // early return — always fine for this deployment since the agency org holds
  // the Salesforge key; if a Salesforge-less org ever needs native analytics,
  // lift this block above that return.
  {
    let nativeQuery = admin
      .from("campaigns")
      .select("id")
      .eq("source_channel", "native_email");
    // ?campaign_id= refreshes one campaign regardless of status (mirrors the
    // Salesforge targeted path); otherwise only active campaigns are synced.
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

  return NextResponse.json({
    synced: totalSynced,
    discovered: totalDiscovered,
    status_updated: totalStatusUpdated,
    contacts_synced: totalContactsSynced,
    contacts_linked_to_campaigns: totalContactsLinked,
    native_synced: totalNativeSynced,
  });
}
