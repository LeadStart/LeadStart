// GET  /api/admin/mailboxes — list native sending inboxes with per-mailbox
//                             usage (sent today, bounces 7d, effective cap).
// POST /api/admin/mailboxes — register a new inbox. Verifies domain-wide
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
  rampWeek,
  startOfLocalDay,
  DEFAULT_MAX_DAILY_CAP,
} from "@/lib/gmail/ramp";
import type { NativeMailbox } from "@/types/app";

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

  const enriched = mailboxes.map((mb) => ({
    ...mb,
    sent_today: sentToday[mb.id] ?? 0,
    bounced_7d: bounced7d[mb.id] ?? 0,
    effective_daily_cap: effectiveDailyCap(mb),
    ramp_week: rampWeek(mb),
  }));

  return NextResponse.json({ mailboxes: enriched });
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
  // store it — a cheap getProfile round-trips the whole JWT→token→API path.
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

  const insert = {
    organization_id: organizationId,
    email_address: email,
    display_name: body.display_name?.trim() || null,
    client_id: body.client_id || null,
    max_daily_cap:
      typeof body.max_daily_cap === "number" && body.max_daily_cap > 0
        ? Math.floor(body.max_daily_cap)
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
