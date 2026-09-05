import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { syncCampaignTagPool } from "@/lib/campaigns/tag-pool-sync";

// Force dynamic so a Vercel cron never gets an edge-cached body.
export const dynamic = "force-dynamic";
// Explicit function budget (SEND_RUNTIME_AUDIT.md CRON-05): never rely on the
// project's Fluid-compute default (300s per Vercel's docs, read 2026-09-05).
export const maxDuration = 60;

// Live mailbox-tag reconcile (migration 00119).
//
// Every campaign that "follows" a tag (campaigns.mailbox_tag IS NOT NULL, not
// completed) has its rotation pool (campaign_mailboxes) re-synced to the inboxes
// currently carrying that tag. This is what makes tag membership behave like a
// LIVE pool: an inbox added to the tag auto-joins the campaign here, an inbox
// removed drops from new first-touches. The binding route reconciles on the spot;
// this cron catches every change made afterward (on the Mailboxes page, the Tags
// manager, etc.).
//
// Fully inert until used: no bound campaigns → no-op. The SEND PATH is untouched;
// run-native-sequences keeps reading campaign_mailboxes verbatim.
//
// Campaigns are reconciled SEQUENTIALLY so the dedicated-inbox policy is coherent
// within a tick: if two bound campaigns share a newly-tagged inbox, the first to
// reconcile claims it and the second sees it as in-use. The fleet is small, so
// per-row work is fine.
export async function GET(req: NextRequest) {
  const authErr = checkCronAuth(req);
  if (authErr) return authErr;

  const admin = createAdminClient();

  const { data: bound, error } = await admin
    .from("campaigns")
    .select("id, organization_id, name, mailbox_tag")
    .not("mailbox_tag", "is", null)
    .neq("status", "completed");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (bound ?? []) as {
    id: string;
    organization_id: string;
    name: string;
    mailbox_tag: string | null;
  }[];

  let added = 0;
  let removed = 0;
  let emptyGuarded = 0;
  const changed: { campaign: string; tag: string | null; added: number; removed: number }[] = [];
  const errors: { campaign: string; error: string }[] = [];

  for (const c of rows) {
    try {
      const r = await syncCampaignTagPool(admin, c.organization_id, c.id, c.mailbox_tag);
      added += r.added.length;
      removed += r.removed.length;
      if (r.emptyGuard) emptyGuarded += 1;
      if (r.added.length > 0 || r.removed.length > 0) {
        changed.push({ campaign: c.name, tag: r.tag, added: r.added.length, removed: r.removed.length });
      }
    } catch (e) {
      errors.push({ campaign: c.name, error: e instanceof Error ? e.message : "sync failed" });
    }
  }

  return NextResponse.json({
    ok: true,
    bound_campaigns: rows.length,
    inboxes_added: added,
    inboxes_removed: removed,
    empty_guarded: emptyGuarded,
    changed,
    errors,
  });
}
