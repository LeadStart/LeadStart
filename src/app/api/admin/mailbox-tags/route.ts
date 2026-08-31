// /api/admin/mailbox-tags — backend for the Settings → Tags manager. Manages the
// per-org mailbox tag registry (mailbox_tags, migration 00108) and cascades
// rename/delete across every native_mailboxes.tags[] in the org. Owner-only,
// org-scoped, admin-client writes — same auth + per-row fan-out shape as
// /api/admin/mailboxes/tags. Verbs:
//   GET    → list tag summaries (registry ∪ tags in use, with per-tag counts)
//   POST   → add a tag to the registry           { name }
//   PATCH  → rename a tag everywhere             { id?, name, new_name }
//   DELETE → delete a tag everywhere             { id?, name }
//
// The registry is the canonical vocabulary; a tag can exist there with zero
// inboxes. Ad-hoc tags added on the Mailboxes chip input (never adopted) still
// surface here as `registered: false` so they can be renamed/deleted/adopted.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeTag, type MailboxTagSummary } from "@/lib/mailboxes/tags";

type Admin = ReturnType<typeof createAdminClient>;
type Ctx = { admin: Admin; organizationId: string };

// Owner + org guard shared by every verb. Returns a NextResponse on failure so
// callers can `if (ctx instanceof NextResponse) return ctx;`.
async function requireOwner(): Promise<Ctx | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }
  return { admin: createAdminClient(), organizationId };
}

// Migration 00108 not applied yet. The registry reads degrade instead of
// hard-failing; writes surface a "not set up yet" message. Two shapes: PostgREST
// reports a schema-cache miss (PGRST205); a direct-PG path reports undefined_table
// (42P01). Match the message too as a belt-and-suspenders fallback.
function isMissingTable(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "PGRST205") return true;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("schema cache") || m.includes("does not exist");
}

// Distinct tags in use across the org's inboxes → lowercased key → {name, count}.
// A tag counts once per inbox even if that inbox's array somehow repeats it.
async function usageMap(
  admin: Admin,
  organizationId: string,
): Promise<Map<string, { name: string; count: number }>> {
  const { data, error } = await admin
    .from("native_mailboxes")
    .select("tags")
    .eq("organization_id", organizationId);
  if (error) throw new Error(error.message);
  const map = new Map<string, { name: string; count: number }>();
  for (const row of (data ?? []) as { tags: string[] | null }[]) {
    const seen = new Set<string>();
    for (const raw of row.tags ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { name, count: 1 });
    }
  }
  return map;
}

// Rename or remove `oldName` (case-insensitive) across every org inbox's tags[].
// newName === null deletes it; otherwise replaces it, deduping if the target
// name is already present on that inbox. Bounded by the small sending fleet, so
// a simple per-row parallel fan-out (like the bulk tag route) is fine. Returns
// the number of inboxes changed.
async function cascadeAcrossMailboxes(
  admin: Admin,
  organizationId: string,
  oldName: string,
  newName: string | null,
): Promise<number> {
  const { data, error } = await admin
    .from("native_mailboxes")
    .select("id, tags")
    .eq("organization_id", organizationId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id: string; tags: string[] | null }[];
  const oldKey = oldName.toLowerCase();
  const changed = rows.filter((r) =>
    (r.tags ?? []).some((t) => t.toLowerCase() === oldKey),
  );

  await Promise.all(
    changed.map(async (r) => {
      const kept: string[] = [];
      const seen = new Set<string>();
      for (const t of r.tags ?? []) {
        const replacement = t.toLowerCase() === oldKey ? newName : t;
        if (replacement === null) continue; // delete
        const key = replacement.toLowerCase();
        if (seen.has(key)) continue; // dedupe (rename landing on an existing tag)
        seen.add(key);
        kept.push(replacement);
      }
      const { error: upErr } = await admin
        .from("native_mailboxes")
        .update({ tags: kept })
        .eq("id", r.id)
        .eq("organization_id", organizationId);
      if (upErr) throw new Error(upErr.message);
    }),
  );
  return changed.length;
}

export async function GET() {
  const ctx = await requireOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, organizationId } = ctx;

  let usage: Map<string, { name: string; count: number }>;
  try {
    usage = await usageMap(admin, organizationId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load mailboxes" },
      { status: 500 },
    );
  }

  // Registry (migration 00108). If the table isn't there yet, degrade to the
  // in-use-only view so the page still renders and can say the registry isn't
  // ready — rather than 500-ing before the migration is applied.
  let registryAvailable = true;
  const registry = new Map<string, { id: string; name: string }>();
  const { data: regRows, error: regErr } = await admin
    .from("mailbox_tags")
    .select("id, name")
    .eq("organization_id", organizationId);
  if (regErr) {
    if (isMissingTable(regErr)) registryAvailable = false;
    else return NextResponse.json({ error: regErr.message }, { status: 500 });
  } else {
    for (const r of (regRows ?? []) as { id: string; name: string }[]) {
      registry.set(r.name.toLowerCase(), { id: r.id, name: r.name });
    }
  }

  // Merge: every registry tag (registered), plus in-use tags absent from the
  // registry (unregistered, id null). Usage supplies the count for both.
  const byKey = new Map<string, MailboxTagSummary>();
  for (const [key, reg] of registry) {
    byKey.set(key, {
      id: reg.id,
      name: reg.name,
      mailbox_count: usage.get(key)?.count ?? 0,
      registered: true,
    });
  }
  for (const [key, u] of usage) {
    if (byKey.has(key)) continue;
    byKey.set(key, { id: null, name: u.name, mailbox_count: u.count, registered: false });
  }

  const tags = [...byKey.values()].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  return NextResponse.json({ tags, registry_available: registryAvailable });
}

export async function POST(req: NextRequest) {
  const ctx = await requireOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, organizationId } = ctx;

  let body: { name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = normalizeTag(body.name);
  if (!name) return NextResponse.json({ error: "Tag name is required" }, { status: 400 });

  const { data, error } = await admin
    .from("mailbox_tags")
    .insert({ organization_id: organizationId, name })
    .select("id, name")
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json(
        { error: "Tag registry isn’t set up yet — apply migration 00108." },
        { status: 503 },
      );
    }
    if (error.code === "23505") {
      return NextResponse.json({ error: `A tag named “${name}” already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ tag: data });
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, organizationId } = ctx;

  let body: { id?: unknown; name?: unknown; new_name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" && body.id ? body.id : null;
  const oldName = normalizeTag(body.name);
  const newName = normalizeTag(body.new_name);
  if (!oldName) return NextResponse.json({ error: "Current tag name is required" }, { status: 400 });
  if (!newName) return NextResponse.json({ error: "New tag name is required" }, { status: 400 });

  const oldKey = oldName.toLowerCase();
  const newKey = newName.toLowerCase();

  // Load the registry to (a) detect a collision with a DIFFERENT tag and (b)
  // find the row to rename (by id, or by name for an ad-hoc adoption).
  let registryAvailable = true;
  let regRows: { id: string; name: string }[] = [];
  const { data, error } = await admin
    .from("mailbox_tags")
    .select("id, name")
    .eq("organization_id", organizationId);
  if (error) {
    if (isMissingTable(error)) registryAvailable = false;
    else return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    regRows = (data ?? []) as { id: string; name: string }[];
  }

  // Collision: a different registered tag already owns the new name. A pure
  // recase (same key) is allowed and just rewrites casing everywhere.
  if (newKey !== oldKey) {
    const clash = regRows.find((r) => r.name.toLowerCase() === newKey && r.id !== id);
    if (clash) {
      return NextResponse.json(
        { error: `A tag named “${newName}” already exists — delete it first or pick another name.` },
        { status: 409 },
      );
    }
  }

  if (registryAvailable) {
    const target = id
      ? regRows.find((r) => r.id === id)
      : regRows.find((r) => r.name.toLowerCase() === oldKey);
    if (target) {
      const { error: upErr } = await admin
        .from("mailbox_tags")
        .update({ name: newName })
        .eq("id", target.id)
        .eq("organization_id", organizationId);
      if (upErr) {
        if (upErr.code === "23505") {
          return NextResponse.json({ error: `A tag named “${newName}” already exists.` }, { status: 409 });
        }
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }
    } else if (!regRows.some((r) => r.name.toLowerCase() === newKey)) {
      // Renaming an ad-hoc (unregistered) tag → adopt it under the new name so
      // the vocabulary converges. Guarded by the unique index.
      const { error: insErr } = await admin
        .from("mailbox_tags")
        .insert({ organization_id: organizationId, name: newName });
      if (insErr && insErr.code !== "23505") {
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
    }
  }

  let changed = 0;
  try {
    changed = await cascadeAcrossMailboxes(admin, organizationId, oldName, newName);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Rename cascade failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, renamed_to: newName, mailboxes_updated: changed });
}

export async function DELETE(req: NextRequest) {
  const ctx = await requireOwner();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, organizationId } = ctx;

  let body: { id?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" && body.id ? body.id : null;
  const name = normalizeTag(body.name);
  // Name is required for the cascade (an id alone doesn't tell us what to strip
  // from the arrays). The page always sends the name.
  if (!name) return NextResponse.json({ error: "Tag name is required" }, { status: 400 });

  // Registered tag → drop its registry row. Unregistered (id null) → nothing to
  // delete there; the cascade below removes it from the inboxes.
  if (id) {
    const { error } = await admin
      .from("mailbox_tags")
      .delete()
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (error && !isMissingTable(error)) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  let changed = 0;
  try {
    changed = await cascadeAcrossMailboxes(admin, organizationId, name, null);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Delete cascade failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, mailboxes_updated: changed });
}
