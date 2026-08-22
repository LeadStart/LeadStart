// GET  /api/admin/mailboxes/[id]/placement — the mailbox's latest placement
//      test + per-seed results. If that test is still 'awaiting' and past the
//      check delay, runs ONE check pass first, so the page's 10-second polling
//      is what drives the answer (typically ~1 minute after sending). The
//      run-placement-tests cron covers closed tabs and the 30-minute timeout.
// POST /api/admin/mailboxes/[id]/placement — start a test.
//      Body: { probe?: "neutral" | "campaign" }. 'neutral' sends a short,
//      realistic, link-free note (reputation + auth in isolation); 'campaign'
//      sends step 1 of the campaign this mailbox is pooled into, rendered with
//      sample merge values (the real copy). Run both to split "the domain has
//      a problem" from "this copy trips the filter".
// Owner only. Migration 00068.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import {
  PlacementError,
  checkPlacementTest,
  latestPlacementTests,
  startPlacementTest,
} from "@/lib/deliverability/placement-runner";
import { PLACEMENT_CHECK_DELAY_MS } from "@/lib/deliverability/placement";
import type { NativeMailbox, PlacementProbe, PlacementTest, PlacementTestResult, SeedInbox } from "@/types/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteParams {
  params: Promise<{ id: string }>;
}

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

async function loadMailbox(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  organizationId: string,
): Promise<NativeMailbox | null> {
  const { data } = await admin
    .from("native_mailboxes")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as NativeMailbox | null) ?? null;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return (at >= 0 ? email.slice(at + 1) : email).toLowerCase();
}

/** Active seeds that can actually measure this mailbox (different domain). */
async function seedsAvailableFor(
  admin: ReturnType<typeof createAdminClient>,
  mailbox: NativeMailbox,
): Promise<number> {
  const { data } = await admin
    .from("seed_inboxes")
    .select("email_address")
    .eq("organization_id", mailbox.organization_id)
    .eq("status", "active");
  const senderDomain = domainOf(mailbox.email_address);
  return ((data ?? []) as Pick<SeedInbox, "email_address">[]).filter(
    (s) => domainOf(s.email_address) !== senderDomain,
  ).length;
}

async function loadResults(
  admin: ReturnType<typeof createAdminClient>,
  testId: string,
): Promise<PlacementTestResult[]> {
  const { data } = await admin
    .from("placement_test_results")
    .select("*")
    .eq("test_id", testId)
    .order("seed_email", { ascending: true });
  return (data ?? []) as PlacementTestResult[];
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  const admin = createAdminClient();
  const mailbox = await loadMailbox(admin, id, organizationId);
  if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

  const seedsAvailable = await seedsAvailableFor(admin, mailbox);
  const latest = (await latestPlacementTests(admin, [mailbox.id])).get(mailbox.id) ?? null;
  if (!latest) {
    return NextResponse.json({ test: null, results: [], seeds_available: seedsAvailable });
  }

  let test: PlacementTest = latest;
  let results: PlacementTestResult[];
  const dueForCheck =
    test.status === "awaiting" &&
    !!test.sent_at &&
    Date.now() - Date.parse(test.sent_at) >= PLACEMENT_CHECK_DELAY_MS;
  if (dueForCheck) {
    try {
      const checked = await checkPlacementTest({ admin, test });
      test = checked.test;
      results = checked.results;
    } catch (err) {
      // A failed check pass is not a failed test — return what we have and let
      // the next poll (or the cron) try again.
      console.error("[placement] check pass failed:", err instanceof Error ? err.message : err);
      results = await loadResults(admin, test.id);
    }
  } else {
    results = await loadResults(admin, test.id);
  }

  return NextResponse.json({ test, results, seeds_available: seedsAvailable });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;
  const { id } = await params;

  let body: { probe?: string } = {};
  try {
    body = (await req.json()) as { probe?: string };
  } catch {
    /* optional body */
  }
  const probe: PlacementProbe = body.probe === "campaign" ? "campaign" : "neutral";

  const admin = createAdminClient();
  const mailbox = await loadMailbox(admin, id, organizationId);
  if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
  if (mailbox.status === "error") {
    return NextResponse.json(
      { error: "This mailbox is in an error state — fix its delegation and resume it first." },
      { status: 400 },
    );
  }

  try {
    const { test, results } = await startPlacementTest({
      admin,
      mailbox,
      probe,
      triggeredBy: "manual",
    });
    return NextResponse.json({ test, results });
  } catch (err) {
    if (err instanceof PlacementError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof GmailConfigError || err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Placement test failed to start: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
