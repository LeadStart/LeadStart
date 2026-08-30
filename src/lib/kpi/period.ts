import type { CampaignSnapshot } from "@/types/app";

// Time-window lens for the admin analytics surfaces (Overview portfolio + All
// Campaigns list). Reply / bounce / positive are cumulative quality metrics, so
// a rolling 30-day window understates the reply rate badly — the denominator
// (leads first-contacted in the window) counts fresh leads who have not had time
// to reply yet. All-Time is therefore the default; 7d / 30d remain available as
// recent-activity lenses. Mirrors the 7d/30d/lifetime toggle on the client
// dossier (client-detail-client.tsx).
export type MetricsPeriod = "7d" | "30d" | "all";

export const METRICS_PERIODS: MetricsPeriod[] = ["7d", "30d", "all"];

// All-Time is the default across the admin analytics surfaces — never 30 days.
export const DEFAULT_METRICS_PERIOD: MetricsPeriod = "all";

export const PERIOD_LABELS: Record<MetricsPeriod, string> = {
  "7d": "7 Days",
  "30d": "30 Days",
  all: "All-Time",
};

// Prose fragment for footnotes, e.g. "reflect all-time" / "reflect the last 7 days".
export const PERIOD_BLURBS: Record<MetricsPeriod, string> = {
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  all: "all-time",
};

// Filter daily snapshots to the selected rolling window. "all" is a pass-through.
// `now` is injected so React callers can pass a render-stable clock —
// react-hooks/purity forbids calling Date.now() during render.
export function filterSnapshotsByPeriod(
  snapshots: CampaignSnapshot[],
  period: MetricsPeriod,
  now: number = Date.now(),
): CampaignSnapshot[] {
  if (period === "all") return snapshots;
  const days = period === "7d" ? 7 : 30;
  const cutoff = new Date(now - days * 86400000).toISOString().split("T")[0];
  return snapshots.filter((s) => s.snapshot_date >= cutoff);
}
