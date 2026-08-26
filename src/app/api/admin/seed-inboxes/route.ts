// GET  /api/admin/seed-inboxes — list the org's inbox-placement seed panel.
// POST /api/admin/seed-inboxes — add one seed, by provider:
//   google_workspace (default) — verifies domain-wide delegation live via
//                                getProfile, same as adding a sending mailbox.
//   imap                       — verifies an app-password IMAP login live
//                                (Yahoo, consumer Gmail, generic).
//   microsoft_graph            — added via the Connect flow, not this route.
//   { import_sending_mailboxes: true } — register every sending mailbox as a
//                                seed (already DWD-verified; free cross-domain panel).
// Owner only. Migrations 00068 + 00085.
//
// The seed row's `auth` column (IMAP password / Graph refresh token) is NEVER
// returned to the browser — every read here uses SEED_SELECT, and migration
// 00085 revokes column-level SELECT on `auth` from the client roles as a
// backstop. Server code uses the service-role client and is unaffected.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import { GmailConfigError, GmailAuthError } from "@/lib/gmail/client";
import { verifyImapLogin, ImapAuthError, ImapTransientError } from "@/lib/imap/client";
import type { NativeMailbox, SeedInbox } from "@/types/app";

// IMAP needs raw TCP/TLS sockets — pin the Node runtime (matches the placement route).
export const runtime = "nodejs";

// Browser-safe columns — everything on seed_inboxes EXCEPT `auth`.
const SEED_SELECT =
  "id, organization_id, email_address, label, provider, role, status, last_error, last_error_at, created_at, updated_at";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
    .select(SEED_SELECT)
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

const roleSchema = z.enum(["veteran", "fresh"]).optional();

const imapSeedSchema = z.object({
  provider: z.literal("imap"),
  email_address: z.string().trim(),
  label: z.string().trim().optional(),
  role: roleSchema,
  imap: z.object({
    host: z.string().trim().min(1, "IMAP host is required"),
    port: z.number().int().positive().max(65535).default(993),
    username: z.string().trim().optional(),
    password: z.string().min(1, "IMAP password is required"),
  }),
});

interface CreateBody {
  provider?: string;
  email_address?: string;
  label?: string;
  role?: string;
  import_sending_mailboxes?: boolean;
  imap?: unknown;
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

  // ---- Microsoft: added through the OAuth Connect flow, never here ----
  if (body.provider === "microsoft_graph") {
    return NextResponse.json(
      { error: "Microsoft seeds are added with the Connect Microsoft button." },
      { status: 400 },
    );
  }

  // ---- IMAP seed (Yahoo, consumer Gmail, generic) ----
  if (body.provider === "imap") {
    const parsed = imapSeedSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid IMAP seed details" },
        { status: 400 },
      );
    }
    const email = parsed.data.email_address.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
    }
    const imapAuth = {
      host: parsed.data.imap.host,
      port: parsed.data.imap.port,
      username: (parsed.data.imap.username || email).trim(),
      password: parsed.data.imap.password,
    };

    // Live login gate — the IMAP analog of the DWD getProfile check. A seed we
    // can't read is useless, and a clear failure here beats a silent
    // "unreadable" every probe.
    try {
      await verifyImapLogin(imapAuth);
    } catch (err) {
      if (err instanceof ImapAuthError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof ImapTransientError) {
        return NextResponse.json({ error: err.message }, { status: 502 });
      }
      return NextResponse.json(
        { error: `Could not reach the IMAP server: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }

    const { data, error } = await admin
      .from("seed_inboxes")
      .insert({
        organization_id: organizationId,
        email_address: email,
        label: parsed.data.label || null,
        provider: "imap",
        role: parsed.data.role ?? null,
        auth: imapAuth,
      })
      .select(SEED_SELECT)
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "That seed inbox is already registered." }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ seed: data as SeedInbox });
  }

  // ---- Google Workspace seed (default): live DWD read check ----
  const email = (body.email_address ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }
  const roleParsed = roleSchema.safeParse(body.role);
  if (!roleParsed.success) {
    return NextResponse.json({ error: "Invalid seed role" }, { status: 400 });
  }

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
      role: roleParsed.data ?? null,
    })
    .select(SEED_SELECT)
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "That seed inbox is already registered." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ seed: data as SeedInbox });
}
