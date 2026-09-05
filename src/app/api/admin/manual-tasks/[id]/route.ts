import { NextRequest, NextResponse } from "next/server";
import { requireManualTaskContext } from "@/lib/manual-tasks/auth";
import type { ManualTaskStatus } from "@/types/app";

// PATCH /api/admin/manual-tasks/[id]  { status: "done" | "skipped" | "open" }
//
// The complete / skip / reopen action behind the inbox. `done` and `skipped`
// stamp completed_at (now); `open` clears it (undo). Org ownership is re-checked
// even though the admin client bypasses RLS: defense in depth.

export const maxDuration = 10;

const VALID_STATUS = new Set<ManualTaskStatus>(["open", "done", "skipped"]);

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireManualTaskContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { status?: unknown };
  const status =
    typeof body.status === "string" ? (body.status as ManualTaskStatus) : null;
  if (!status || !VALID_STATUS.has(status)) {
    return NextResponse.json(
      { error: "status must be one of open, done, skipped" },
      { status: 400 },
    );
  }

  const { data: row, error: readErr } = await admin
    .from("manual_tasks")
    .select("id, organization_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if ((row as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error: updErr } = await admin
    .from("manual_tasks")
    .update({
      status,
      completed_at: status === "open" ? null : new Date().toISOString(),
    })
    .eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, status });
}
