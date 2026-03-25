import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const BASE_URL = "https://api.instantly.ai/api/v2";

async function instantlyFetch(apiKey: string, endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instantly API error ${res.status}: ${body}`);
  }
  return res.json();
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: profile } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", user.id)
      .single();
    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 404 });

    const { data: org } = await supabase
      .from("organizations")
      .select("instantly_api_key")
      .eq("id", profile.organization_id)
      .single();
    if (!org?.instantly_api_key) {
      return NextResponse.json({ error: "No Instantly API key configured" }, { status: 400 });
    }

    const apiKey = org.instantly_api_key;

    // Paginate all accounts
    const accounts: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("starting_after", cursor);
      const res = await instantlyFetch(apiKey, `/accounts?${params.toString()}`);
      accounts.push(...(res.items || []));
      cursor = res.next_starting_after;
    } while (cursor);

    // Get daily analytics (30d) — gracefully handle failure
    let dailyData: { email: string; date: string; sent: number }[] = [];
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
      const today = new Date().toISOString().split("T")[0];
      const res = await instantlyFetch(apiKey, `/accounts/analytics/daily?start_date=${thirtyDaysAgo}&end_date=${today}`);
      dailyData = res.data || res || [];
    } catch { /* skip if not available */ }

    // Build daily sending totals per email
    const dailySendMap = new Map<string, number>();
    if (Array.isArray(dailyData)) {
      for (const d of dailyData) {
        if (d.email && d.sent) {
          dailySendMap.set(d.email, (dailySendMap.get(d.email) || 0) + d.sent);
        }
      }
    }

    // Aggregate by domain
    const domainStats = new Map<string, { inboxes: number; totalHealth: number; healthCount: number; totalSent: number }>();

    // Build per-inbox results using account data directly
    const inboxes = accounts.map((account: Record<string, unknown>) => {
      const email = account.email as string;
      const domain = email.split("@")[1] || "unknown";
      const status = account.status === 1 ? "active" : "inactive";
      const warmupStatus = (account.warmup_status as number) || 0;
      // stat_warmup_score is returned directly on the account object
      const healthScore = typeof account.stat_warmup_score === "number" ? account.stat_warmup_score : null;
      const sent30d = dailySendMap.get(email) || 0;
      const dailyLimit = (account.daily_limit as number) || 0;
      const firstName = (account.first_name as string) || "";
      const lastName = (account.last_name as string) || "";

      // Domain aggregation
      const ds = domainStats.get(domain) || { inboxes: 0, totalHealth: 0, healthCount: 0, totalSent: 0 };
      ds.inboxes++;
      if (healthScore !== null) { ds.totalHealth += healthScore; ds.healthCount++; }
      ds.totalSent += sent30d;
      domainStats.set(domain, ds);

      return {
        email,
        domain,
        name: [firstName, lastName].filter(Boolean).join(" ") || null,
        status,
        warmupStatus,
        healthScore,
        sent30d,
        dailyLimit,
        createdAt: account.timestamp_created as string,
      };
    });

    // Build domain summary
    const domains = Array.from(domainStats.entries()).map(([domain, stats]) => ({
      domain,
      inboxCount: stats.inboxes,
      avgHealthScore: stats.healthCount > 0 ? Math.round(stats.totalHealth / stats.healthCount) : null,
      totalSent30d: stats.totalSent,
    }));

    const withHealth = inboxes.filter((i) => i.healthScore !== null);
    const avgHealth = withHealth.length > 0
      ? Math.round(withHealth.reduce((sum, i) => sum + (i.healthScore || 0), 0) / withHealth.length)
      : null;

    return NextResponse.json({
      inboxes,
      domains,
      summary: {
        totalInboxes: inboxes.length,
        activeInboxes: inboxes.filter((i) => i.status === "active").length,
        avgHealthScore: avgHealth,
        lowHealthCount: inboxes.filter((i) => i.healthScore !== null && i.healthScore < 50).length,
      },
    });
  } catch (error) {
    console.error("Inbox health error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch inbox health" },
      { status: 500 }
    );
  }
}
