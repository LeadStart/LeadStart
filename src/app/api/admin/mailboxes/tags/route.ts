// POST /api/admin/mailboxes/tags — bulk add/remove tags across many inboxes.
// Owner-only, org-scoped. Body: { mailbox_ids: string[], add?: string[],
// remove?: string[] }. `add` and `remove` are the same for every selected inbox;
// each row's resulting tag list is recomputed from its own existing tags (add is
// appended + deduped, remove drops case-insensitively), so this is idempotent and
// safe to re-run. Returns the updated { mailboxes }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeTags } from "@/lib/mailboxes/tags";
import type { NativeMailbox } from "@/types/app";

export async function POST(req: NextRequest) {
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

  let body: { mailbox_ids?: unknown; add?: unknown; remove?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mailboxIds = Array.isArray(body.mailbox_ids)
    ? [...new Set(body.mailbox_ids.filter((v): v is string => typeof v === "string" && !!v))]
    : [];
  if (mailboxIds.length === 0) {
    return NextResponse.json({ error: "mailbox_ids is required" }, { status: 400 });
  }
  const add = normalizeTags(body.add);
  // `remove` is matched case-insensitively; normalize to lowercase keys.
  const removeKeys = new Set(normalizeTags(body.remove).map((t) => t.toLowerCase()));
  if (add.length === 0 && removeKeys.size === 0) {
    return NextResponse.json(
      { error: "Provide at least one tag to add or remove" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Load the selected inboxes (org-scoped) with their current tags.
  const { data: rows, error: loadErr } = await admin
    .from("native_mailboxes")
    .select("id, tags")
    .eq("organization_id", organizationId)
    .in("id", mailboxIds);
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  const mailboxes = (rows ?? []) as { id: string; tags: string[] | null }[];

  // Per-row recompute (each row keeps its own other tags) → update. Bounded by
  // the operator's selection, so a simple parallel fan-out is fine.
  const updated = await Promise.all(
    mailboxes.map(async (mb) => {
      const kept = (mb.tags ?? []).filter((t) => !removeKeys.has(t.toLowerCase()));
      const nextTags = normalizeTags([...kept, ...add]);
      const { data, error } = await admin
        .from("native_mailboxes")
        .update({ tags: nextTags })
        .eq("id", mb.id)
        .eq("organization_id", organizationId)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as NativeMailbox;
    }),
  ).catch((err: unknown) => {
    return err instanceof Error ? err : new Error(String(err));
  });

  if (updated instanceof Error) {
    return NextResponse.json({ error: updated.message }, { status: 500 });
  }

  return NextResponse.json({ mailboxes: updated, updated: updated.length });
}
