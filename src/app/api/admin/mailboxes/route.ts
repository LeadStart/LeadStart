// GET  /api/admin/mailboxes: list native sending inboxes with per-mailbox
//                             usage (sent today, bounces 7d, effective cap),
//                             the latest placement test per mailbox, and the
//                             org's active seed count (migration 00068).
// POST /api/admin/mailboxes: register a new inbox. Verifies domain-wide
//                             delegation live (getProfile) before inserting,
//                             so a mis-authorized domain fails loudly here
//                             instead of silently in the send cron.
// Owner only.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import {
  GmailConfigError,
  GmailAuthError,
} from "@/lib/gmail/client";
import {
  effectiveDailyCap,
  rampStage,
  startOfLocalDay,
  DEFAULT_MAX_DAILY_CAP,
  ABSOLUTE_MAX_DAILY_CAP,
} from "@/lib/gmail/ramp";
import { latestPlacementTests } from "@/lib/deliverability/placement-runner";
import { mailboxUsageMap } from "@/lib/campaigns/mailbox-usage";
import type { NativeMailbox, SendingDomain } from "@/types/app";

async function requireOwner() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (user.app_metadata?.role !== "owner") {
    return { error: NextResponse.json({ error: "Owner role required" }, { status: 403 }) };
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return { error: NextResponse.json({ error: "No organization on user" }, { status: 400 }) };
  }
  return { organizationId };
}

/**
 * Resolve (or create) the sending_domains row for a mailbox's domain and return
 * its id, so the new mailbox can be linked (domain_id). Mirrors the 00081
 * backfill for hand-added mailboxes: Gmail-tier, already active. Non-fatal,
 * returns null on any failure so the mailbox still saves (unlinked, as before).
 * Handles the create race via the UNIQUE(org, domain) constraint.
 */
async function resolveDomainId(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  domain: string | undefined,
): Promise<string | null> {
  if (!domain) return null;
  const bare = domain.trim().toLowerCase();
  const select = () =>
    admin
      .from("sending_domains")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("domain", bare)
      .maybeSingle();

  const { data: found } = await select();
  if (found?.id) return found.id as string;

  const { data: created, error } = await admin
    .from("sending_domains")
    .insert({
      organization_id: organizationId,
      domain: bare,
      tier: "gmail",
      lifecycle_status: "active",
      registrar: "manual",
    })
    .select("id")
    .single();
  if (created?.id) return created.id as string;
  // Lost the create race (another request inserted the same domain) → re-select.
  if (error?.code === "23505") {
    const { data: raced } = await select();
    return (raced?.id as string) ?? null;
  }
  return null;
}

export async function GET() {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const admin = createAdminClient();
  const { data: mailboxRows, error } = await admin
    .from("native_mailboxes")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const mailboxes = (mailboxRows ?? []) as NativeMailbox[];

  // Usage: one pass over the last 7 days of sends for the whole org.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const dayStart = startOfLocalDay();
  const { data: sendRows } = await admin
    .from("native_sends")
    .select("mailbox_id, status, sent_at")
    .eq("organization_id", organizationId)
    .gte("sent_at", sevenDaysAgo);
  const sends = (sendRows ?? []) as {
    mailbox_id: string;
    status: string;
    sent_at: string;
  }[];

  const sentToday: Record<string, number> = {};
  const bounced7d: Record<string, number> = {};
  for (const s of sends) {
    if (Date.parse(s.sent_at) >= dayStart) {
      sentToday[s.mailbox_id] = (sentToday[s.mailbox_id] ?? 0) + 1;
    }
    if (s.status === "bounced") {
      bounced7d[s.mailbox_id] = (bounced7d[s.mailbox_id] ?? 0) + 1;
    }
  }

  // Cumulative all-time sends per mailbox drive the volume-based warmup ramp.
  // Count-only queries (head:true), one per mailbox, run in parallel, and in
  // parallel with the placement + seed lookups, which are independent.
  const totalSent: Record<string, number> = {};
  const [, latestPlacement, seedCountResult, domainRes, usage] = await Promise.all([
    Promise.all(
      mailboxes.map(async (mb) => {
        const { count } = await admin
          .from("native_sends")
          .select("id", { count: "exact", head: true })
          .eq("mailbox_id", mb.id);
        totalSent[mb.id] = count ?? 0;
      }),
    ),
    latestPlacementTests(
      admin,
      mailboxes.map((mb) => mb.id),
    ),
    admin
      .from("seed_inboxes")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "active"),
    // Sending domains (migration 00081) with their lifecycle + health rollup,
    // for the domain grouping on the Mailboxes page.
    admin
      .from("sending_domains")
      .select("*")
      .eq("organization_id", organizationId)
      .order("domain", { ascending: true }),
    // Which inboxes are claimed by another non-completed campaign (dedicated-inbox
    // policy): feeds the campaign builder's picker greying.
    mailboxUsageMap(admin, organizationId),
  ]);

  const enriched = mailboxes.map((mb) => {
    const ts = totalSent[mb.id] ?? 0;
    const owner = usage.get(mb.id);
    return {
      ...mb,
      sent_today: sentToday[mb.id] ?? 0,
      bounced_7d: bounced7d[mb.id] ?? 0,
      effective_daily_cap: effectiveDailyCap(mb, ts),
      total_sent: ts,
      warmed: rampStage(ts).warmed,
      latest_placement: latestPlacement.get(mb.id) ?? null,
      in_use: !!owner,
      in_use_by: owner?.campaignName ?? null,
    };
  });

  // Domains + their mailbox counts (for the "group by domain" view).
  const mbCountByDomain: Record<string, number> = {};
  for (const mb of mailboxes) {
    if (mb.domain_id) mbCountByDomain[mb.domain_id] = (mbCountByDomain[mb.domain_id] ?? 0) + 1;
  }
  const domains = ((domainRes.data ?? []) as SendingDomain[]).map((d) => ({
    ...d,
    mailbox_count: mbCountByDomain[d.id] ?? 0,
  }));

  return NextResponse.json({
    mailboxes: enriched,
    seed_count: seedCountResult.count ?? 0,
    domains,
  });
}

interface CreateBody {
  email_address?: string;
  display_name?: string;
  client_id?: string;
  max_daily_cap?: number;
  ramp_started_at?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = (body.email_address ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify domain-wide delegation is authorized for this mailbox before we
  // store it: a cheap getProfile round-trips the whole JWT→token→API path.
  try {
    const gmail = await loadGmailClientForOrg(admin, organizationId);
    await gmail.getProfile(email);
  } catch (err) {
    if (err instanceof GmailConfigError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Could not verify the mailbox: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  // Link the mailbox to its sending_domains row. A mailbox with a NULL
  // domain_id is invisible to manage-mailbox-lifecycle, the domain health
  // rollup, and the drain filter (that gap is what migration 00097 §3 repairs
  // for existing rows). Resolve-or-create mirrors the 00081 backfill: a
  // hand-added mailbox's domain is Gmail-tier and treated as already active.
  const domainId = await resolveDomainId(admin, organizationId, email.split("@")[1]);

  const insert = {
    organization_id: organizationId,
    email_address: email,
    domain_id: domainId,
    display_name: body.display_name?.trim() || null,
    client_id: body.client_id || null,
    max_daily_cap:
      typeof body.max_daily_cap === "number" && body.max_daily_cap > 0
        ? Math.min(Math.floor(body.max_daily_cap), ABSOLUTE_MAX_DAILY_CAP)
        : DEFAULT_MAX_DAILY_CAP,
    ramp_started_at: body.ramp_started_at || undefined, // let the DB default to CURRENT_DATE
  };

  const { data, error } = await admin
    .from("native_mailboxes")
    .insert(insert)
    .select("*")
    .single();
  if (error) {
    // 23505 = unique_violation on (organization_id, email_address)
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That mailbox is already registered." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ mailbox: data as NativeMailbox });
}
