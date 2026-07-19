// GET /api/admin/instantly/inbox-health — on-demand read of the Instantly
// workspace's sending inboxes and their warmup health. Owner or VA.
//
// Instantly manages its own hosted mailboxes (separate from the native
// inbox-health system in migration 00061, which scores our own Google
// inboxes), so this reads live from Instantly's API rather than any local
// table: accounts + warmup analytics (health score, inbox vs spam placement)
// + 30-day send volume, aggregated by sending domain.

import { NextResponse } from "next/server";
import { requireInstantlyContext } from "@/lib/instantly/auth";
import { InstantlyClient } from "@/lib/instantly/client";
import type { InstantlyWarmupAnalytics } from "@/lib/instantly/types";

export async function GET() {
  const ctx = await requireInstantlyContext();
  if ("error" in ctx) return ctx.error;

  const client = new InstantlyClient(ctx.apiKey);

  try {
    const accounts = await client.getAllAccounts();
    if (accounts.length === 0) {
      return NextResponse.json({
        inboxes: [],
        domains: [],
        summary: {
          totalInboxes: 0,
          activeInboxes: 0,
          avgHealthScore: null,
          lowHealthCount: 0,
        },
      });
    }

    const emails = accounts.map((a) => a.email);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // Both best-effort — a warmup or daily-analytics failure shouldn't blank
    // the whole panel.
    const [warmup, daily] = await Promise.all([
      client.getWarmupAnalytics(emails).catch((err) => {
        console.error("[instantly/inbox-health] warmup-analytics failed:", err);
        return [] as InstantlyWarmupAnalytics[];
      }),
      client
        .getAccountDailyAnalytics(emails, thirtyDaysAgo, today)
        .catch((err) => {
          console.error("[instantly/inbox-health] daily-analytics failed:", err);
          return { data: [] as { email: string; date: string; sent: number }[] };
        }),
    ]);

    const warmupByEmail = new Map(warmup.map((w) => [w.email, w]));
    const sentByEmail = new Map<string, number>();
    for (const d of daily.data ?? []) {
      if (d.email) sentByEmail.set(d.email, (sentByEmail.get(d.email) ?? 0) + (d.sent ?? 0));
    }

    const domainStats = new Map<
      string,
      { inboxes: number; totalHealth: number; healthCount: number; totalSent: number }
    >();

    const inboxes = accounts.map((account) => {
      // InstantlyAccount only strongly types the fields we care about; the API
      // returns more (stat_warmup_score, daily_limit). Cast to read them.
      const a = account as unknown as Record<string, unknown>;
      const email = a.email as string;
      const domain = email.split("@")[1] || "unknown";
      const status = a.status === 1 ? "active" : "inactive";
      const w = warmupByEmail.get(email);
      const healthScore =
        typeof w?.health_score === "number"
          ? w.health_score
          : typeof a.stat_warmup_score === "number"
            ? (a.stat_warmup_score as number)
            : null;
      const sent30d = sentByEmail.get(email) ?? 0;

      const ds = domainStats.get(domain) || {
        inboxes: 0,
        totalHealth: 0,
        healthCount: 0,
        totalSent: 0,
      };
      ds.inboxes++;
      if (healthScore !== null) {
        ds.totalHealth += healthScore;
        ds.healthCount++;
      }
      ds.totalSent += sent30d;
      domainStats.set(domain, ds);

      return {
        email,
        domain,
        name: [a.first_name, a.last_name].filter(Boolean).join(" ") || null,
        status,
        warmupStatus: typeof a.warmup_status === "number" ? a.warmup_status : 0,
        healthScore,
        landedInbox: w?.landed_inbox ?? null,
        landedSpam: w?.landed_spam ?? null,
        sent30d,
        dailyLimit: typeof a.daily_limit === "number" ? a.daily_limit : 0,
      };
    });

    const domains = [...domainStats.entries()].map(([domain, s]) => ({
      domain,
      inboxCount: s.inboxes,
      avgHealthScore: s.healthCount > 0 ? Math.round(s.totalHealth / s.healthCount) : null,
      totalSent30d: s.totalSent,
    }));

    const withHealth = inboxes.filter((i) => i.healthScore !== null);
    const avgHealth =
      withHealth.length > 0
        ? Math.round(
            withHealth.reduce((sum, i) => sum + (i.healthScore || 0), 0) /
              withHealth.length,
          )
        : null;

    return NextResponse.json({
      inboxes,
      domains,
      summary: {
        totalInboxes: inboxes.length,
        activeInboxes: inboxes.filter((i) => i.status === "active").length,
        avgHealthScore: avgHealth,
        lowHealthCount: inboxes.filter(
          (i) => i.healthScore !== null && (i.healthScore as number) < 50,
        ).length,
      },
    });
  } catch (error) {
    console.error("[instantly/inbox-health] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch inbox health" },
      { status: 500 },
    );
  }
}
