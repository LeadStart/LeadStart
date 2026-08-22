// GET  /api/admin/seed-inboxes — list the org's inbox-placement seed panel.
// POST /api/admin/seed-inboxes — add one seed (verifies domain-wide delegation
//                                live via getProfile, same as adding a sending
//                                mailbox), OR { import_sending_mailboxes: true }
//                                to register every sending mailbox as a seed.
//                                Sending mailboxes are already DWD-verified, and
//                                any two on different domains can probe each
//                                other — a free cross-domain panel.
// Owner only. Migration 00068.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import type { NativeMailbox, SeedInbox } from "@/types/app";

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

async function listSeeds(admin: ReturnType<typeof createAdminClient>, organizationId: string) {
  const { data, error } = await admin
    .from("seed_inboxes")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SeedInbox[];
}

export async function GET() {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const admin = createAdminClient();
  try {
    const seeds = await listSeeds(admin, auth.organizationId);
    return NextResponse.json({ seeds });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load seed inboxes" },
      { status: 500 },
    );
  }
}

interface CreateBody {
  email_address?: string;
  label?: string;
  import_sending_mailboxes?: boolean;
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

  const admin = createAdminClient();

  // ---- Bulk: every sending mailbox becomes a seed (idempotent) ----
  if (body.import_sending_mailboxes) {
    const { data: mbRows, error: mbError } = await admin
      .from("native_mailboxes")
      .select("email_address, display_name")
      .eq("organization_id", organizationId);
    if (mbError) return NextResponse.json({ error: mbError.message }, { status: 500 });
    const mailboxes = (mbRows ?? []) as Pick<NativeMailbox, "email_address" | "display_name">[];
    if (mailboxes.length === 0) {
      return NextResponse.json({ error: "No sending mailboxes to import yet." }, { status: 400 });
    }
    let before: SeedInbox[];
    try {
      before = await listSeeds(admin, organizationId);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
    const rows = mailboxes.map((mb) => ({
      organization_id: organizationId,
      email_address: mb.email_address.toLowerCase(),
      label: mb.display_name ? `${mb.display_name} (sending mailbox)` : "Sending mailbox",
    }));
    const { error: upsertError } = await admin
      .from("seed_inboxes")
      .upsert(rows, { onConflict: "organization_id,email_address", ignoreDuplicates: true });
    if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });
    const seeds = await listSeeds(admin, organizationId);
    return NextResponse.json({ seeds, imported: seeds.length - before.length });
  }

  // ---- Single seed ----
  const email = (body.email_address ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }

  // Same live DWD check the mailbox route does: a seed we can't read is
  // useless, and failing here is clearer than a silent "unreadable" later.
  try {
    const gmail = await loadGmailClientForOrg(admin, organizationId);
    await gmail.getProfile(email);
  } catch (err) {
    if (err instanceof GmailConfigError || err instanceof GmailAuthError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Could not read the seed inbox: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const { data, error } = await admin
    .from("seed_inboxes")
    .insert({
      organization_id: organizationId,
      email_address: email,
      label: body.label?.trim() || null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "That seed inbox is already registered." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ seed: data as SeedInbox });
}
