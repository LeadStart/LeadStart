import { NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";

// GET /api/admin/apify/spend
//
// The AUTHORITATIVE Apify spend for the current billing cycle, read straight
// from Apify: not our per-run tallies (which drift on retries, aborts, and
// deleted rows). `usageUsd` is Apify's own cycle total; `byActor` breaks the
// actor-run charges down by actor, and (crucially) counts FAILED/ABORTED runs
// too, so nothing is hidden. This is what should match the Apify invoice.

export const maxDuration = 30;

const RUN_LIMIT = 1000;

export async function GET() {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { apifyToken } = ctx;
  if (!apifyToken) {
    return NextResponse.json(
      { error: "Apify API token not set. Save it in /admin/settings/api first." },
      { status: 400 },
    );
  }

  const client = new ApifyClient(apifyToken);
  try {
    const [usage, runs] = await Promise.all([
      client.getMonthlyUsage(),
      client.listRuns({ limit: RUN_LIMIT }),
    ]);

    // Only runs inside the current usage cycle contribute to the breakdown.
    const cycleStartMs = usage.cycleStart ? Date.parse(usage.cycleStart) : 0;
    const inCycle = runs.filter(
      (r) => !cycleStartMs || Date.parse(r.startedAt) >= cycleStartMs,
    );

    const byId = new Map<string, { usd: number; runs: number; notSucceeded: number }>();
    for (const r of inCycle) {
      const e = byId.get(r.actId) ?? { usd: 0, runs: 0, notSucceeded: 0 };
      e.usd += r.usageTotalUsd ?? 0;
      e.runs += 1;
      if (r.status !== "SUCCEEDED") e.notSucceeded += 1;
      byId.set(r.actId, e);
    }

    // Resolve actor display names (best-effort, in parallel).
    const nameEntries = await Promise.all(
      [...byId.keys()].map(async (id) => [id, await client.getActorName(id)] as const),
    );
    const nameMap = new Map(nameEntries);

    const byActor = [...byId.entries()]
      .map(([actorId, e]) => ({ actorId, name: nameMap.get(actorId) ?? actorId, ...e }))
      .sort((a, b) => b.usd - a.usd);

    const runsTotalUsd = inCycle.reduce((a, r) => a + (r.usageTotalUsd ?? 0), 0);

    return NextResponse.json({
      ok: true,
      cycleStart: usage.cycleStart,
      cycleEnd: usage.cycleEnd,
      usageUsd: usage.usageUsd, // authoritative account total for the cycle (incl. storage etc.)
      limitUsd: usage.limitUsd, // monthly hard cap
      runsTotalUsd, // sum of the actor-run charges shown in the breakdown
      runsCounted: inCycle.length,
      truncated: runs.length >= RUN_LIMIT,
      byActor,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load Apify spend" },
      { status: 502 },
    );
  }
}
