import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { InstantlyClient } from "@/lib/instantly/client";

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

    const instantly = new InstantlyClient(org.instantly_api_key);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];

    // Fetch accounts and 30-day daily analytics in parallel. Daily analytics
    // is best-effort — if it fails, we still want to render the page with
    // health scores + campaigns.
    const [accounts, dailyResponse] = await Promise.all([
      instantly.getAllAccounts(),
      instantly
        .getAccountDailyAnalytics(undefined, thirtyDaysAgo, today)
        .catch(() => ({ data: [] as { email: string; date: string; sent: number }[] })),
    ]);

    // Account-campaign mappings are scoped per email on Instantly's side
    // (no list-all endpoint), so fan out one call per inbox in parallel.
    // The InstantlyClient handles 429 retries with exponential backoff.
    const mappingResults = await Promise.all(
      accounts.map(async (account) => {
        const email = (account as unknown as { email: string }).email;
        try {
          const items = await instantly.getAllAccountCampaignMappingsForEmail(email);
          return { email, items };
        } catch (err) {
          console.error(`Failed to fetch campaign mappings for ${email}:`, err);
          return { email, items: [] };
        }
      }),
    );
    const mappings = mappingResults.flatMap((r) => r.items);

    // Resolve Instantly campaign IDs to our own campaigns rows. The hourly
    // sync-analytics cron keeps the campaigns table in step with Instantly,
    // so we can use it as the source of truth for names instead of hitting
    // Instantly a second time.
    const instantlyCampaignIds = Array.from(
      new Set(mappings.map((m) => m.campaign_id)),
    );
    const { data: campaignRows } = instantlyCampaignIds.length > 0
      ? await supabase
          .from("campaigns")
          .select("id, name, instantly_campaign_id")
          .eq("organization_id", profile.organization_id)
          .in("instantly_campaign_id", instantlyCampaignIds)
      : { data: [] as { id: string; name: string; instantly_campaign_id: string }[] };

    const campaignByInstantlyId = new Map<string, { id: string; name: string }>();
    for (const c of campaignRows || []) {
      campaignByInstantlyId.set(c.instantly_campaign_id, { id: c.id, name: c.name });
    }

    const campaignsByEmail = new Map<string, { id: string; name: string }[]>();
    for (const m of mappings) {
      const resolved = campaignByInstantlyId.get(m.campaign_id);
      if (!resolved) continue;
      const arr = campaignsByEmail.get(m.email) || [];
      if (!arr.some((c) => c.id === resolved.id)) arr.push(resolved);
      campaignsByEmail.set(m.email, arr);
    }

    // Build daily sending totals per email
    const dailyData = Array.isArray(dailyResponse)
      ? (dailyResponse as { email: string; sent: number }[])
      : dailyResponse?.data || [];
    const dailySendMap = new Map<string, number>();
    for (const d of dailyData) {
      if (d.email && d.sent) {
        dailySendMap.set(d.email, (dailySendMap.get(d.email) || 0) + d.sent);
      }
    }

    // Aggregate by domain
    const domainStats = new Map<string, { inboxes: number; totalHealth: number; healthCount: number; totalSent: number }>();

    const inboxes = accounts.map((account) => {
      // The InstantlyAccount type only declares the fields we care about
      // strongly; the API actually returns more (stat_warmup_score, daily_limit,
      // timestamp_created). Cast through unknown to access them untyped.
      const a = account as unknown as Record<string, unknown>;
      const email = a.email as string;
      const domain = email.split("@")[1] || "unknown";
      const status = a.status === 1 ? "active" : "inactive";
      const warmupStatus = (a.warmup_status as number) || 0;
      // stat_warmup_score is returned directly on the account object
      const healthScore = typeof a.stat_warmup_score === "number" ? a.stat_warmup_score : null;
      const sent30d = dailySendMap.get(email) || 0;
      const dailyLimit = (a.daily_limit as number) || 0;
      const firstName = (a.first_name as string) || "";
      const lastName = (a.last_name as string) || "";

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
        campaigns: campaignsByEmail.get(email) || [],
        createdAt: a.timestamp_created as string,
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
