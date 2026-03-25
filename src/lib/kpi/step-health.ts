import type { CampaignStepMetric, StepHealthAlert } from "@/types/app";

/**
 * Analyzes step-level metrics to detect performance drops.
 *
 * Logic:
 * - For each campaign + step, compare the LATEST period's rate
 *   against the trailing average of all previous periods.
 * - A "warning" = 25%+ drop from baseline
 * - A "critical" = 50%+ drop from baseline
 *
 * Example: Step 1 reply rate averaged 8% over the last 4 weeks,
 * but this week it's 3% → that's a 62.5% drop → critical alert.
 */

interface CampaignInfo {
  id: string;
  name: string;
  client_name: string;
}

const WARNING_THRESHOLD = 0.25;  // 25% drop
const CRITICAL_THRESHOLD = 0.50; // 50% drop
const MIN_SENT_FOR_ALERT = 20;   // Don't alert on tiny sample sizes

export function analyzeStepHealth(
  metrics: CampaignStepMetric[],
  campaignMap: Map<string, CampaignInfo>
): StepHealthAlert[] {
  const alerts: StepHealthAlert[] = [];

  // Group by campaign_id + step
  const grouped = new Map<string, CampaignStepMetric[]>();
  for (const m of metrics) {
    const key = `${m.campaign_id}::${m.step}`;
    const arr = grouped.get(key) || [];
    arr.push(m);
    grouped.set(key, arr);
  }

  for (const [, stepMetrics] of grouped) {
    // Sort by period_start ascending (oldest first)
    stepMetrics.sort((a, b) => a.period_start.localeCompare(b.period_start));

    if (stepMetrics.length < 2) continue; // Need at least 2 periods to compare

    const latest = stepMetrics[stepMetrics.length - 1];
    const previous = stepMetrics.slice(0, -1);

    // Skip if latest period has too few sends
    if (latest.sent < MIN_SENT_FOR_ALERT) continue;

    const campaign = campaignMap.get(latest.campaign_id);
    if (!campaign) continue;

    // Calculate trailing averages from previous periods
    const prevWithData = previous.filter((p) => p.sent >= MIN_SENT_FOR_ALERT);
    if (prevWithData.length === 0) continue;

    const avgReplyRate = prevWithData.reduce((sum, p) => sum + p.reply_rate, 0) / prevWithData.length;
    const avgBounceRate = prevWithData.reduce((sum, p) => sum + p.bounce_rate, 0) / prevWithData.length;

    // Check reply rate drops (lower is worse)
    if (avgReplyRate > 0 && latest.reply_rate < avgReplyRate) {
      const dropPct = (avgReplyRate - latest.reply_rate) / avgReplyRate;
      if (dropPct >= WARNING_THRESHOLD) {
        alerts.push({
          campaign_id: latest.campaign_id,
          campaign_name: campaign.name,
          client_name: campaign.client_name,
          step: latest.step,
          metric: "reply_rate",
          current_value: latest.reply_rate,
          baseline_value: Number(avgReplyRate.toFixed(2)),
          change_pct: Number((-dropPct * 100).toFixed(1)),
          severity: dropPct >= CRITICAL_THRESHOLD ? "critical" : "warning",
        });
      }
    }

    // Check bounce rate spikes (higher is worse)
    if (latest.bounce_rate > avgBounceRate && avgBounceRate >= 0) {
      const baseline = Math.max(avgBounceRate, 0.5); // avoid division by near-zero
      const spikePct = (latest.bounce_rate - avgBounceRate) / baseline;
      if (spikePct >= WARNING_THRESHOLD && latest.bounce_rate > 2) {
        alerts.push({
          campaign_id: latest.campaign_id,
          campaign_name: campaign.name,
          client_name: campaign.client_name,
          step: latest.step,
          metric: "bounce_rate",
          current_value: latest.bounce_rate,
          baseline_value: Number(avgBounceRate.toFixed(2)),
          change_pct: Number((spikePct * 100).toFixed(1)),
          severity: spikePct >= CRITICAL_THRESHOLD ? "critical" : "warning",
        });
      }
    }
  }

  // Sort: critical first, then by severity of change
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return Math.abs(b.change_pct) - Math.abs(a.change_pct);
  });

  return alerts;
}

/**
 * Get a summary health status for a campaign based on step alerts.
 */
export function getCampaignStepHealth(
  campaignId: string,
  alerts: StepHealthAlert[]
): "good" | "warning" | "critical" | "none" {
  const campaignAlerts = alerts.filter((a) => a.campaign_id === campaignId);
  if (campaignAlerts.length === 0) return "none";
  if (campaignAlerts.some((a) => a.severity === "critical")) return "critical";
  return "warning";
}
