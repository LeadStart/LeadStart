"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, TrendingDown, TrendingUp, Minus, Activity } from "lucide-react";
import type { CampaignStepMetric, StepHealthAlert } from "@/types/app";

interface StepFunnelProps {
  stepMetrics: CampaignStepMetric[];
  alerts: StepHealthAlert[];
  campaignName?: string;
}

/**
 * Groups step metrics by step number and returns:
 * - The latest period's metrics
 * - The trailing average (all previous periods)
 * - A sparkline of the reply rate over time
 */
function processSteps(metrics: CampaignStepMetric[]) {
  const byStep = new Map<number, CampaignStepMetric[]>();
  for (const m of metrics) {
    const arr = byStep.get(m.step) || [];
    arr.push(m);
    byStep.set(m.step, arr);
  }

  const steps: Array<{
    step: number;
    latest: CampaignStepMetric;
    avgReplyRate: number;
    avgBounceRate: number;
    sparkline: number[]; // reply rates over time
    totalSent: number;
    totalReplies: number;
    trend: "up" | "down" | "flat";
  }> = [];

  for (const [step, stepData] of byStep) {
    // Sort ascending by period
    stepData.sort((a, b) => a.period_start.localeCompare(b.period_start));

    const latest = stepData[stepData.length - 1];
    const previous = stepData.slice(0, -1).filter((p) => p.sent >= 10);

    const avgReplyRate = previous.length > 0
      ? previous.reduce((sum, p) => sum + p.reply_rate, 0) / previous.length
      : latest.reply_rate;

    const avgBounceRate = previous.length > 0
      ? previous.reduce((sum, p) => sum + p.bounce_rate, 0) / previous.length
      : latest.bounce_rate;

    const sparkline = stepData.map((d) => d.reply_rate);

    const totalSent = stepData.reduce((sum, d) => sum + d.sent, 0);
    const totalReplies = stepData.reduce((sum, d) => sum + d.unique_replies, 0);

    // Determine trend
    let trend: "up" | "down" | "flat" = "flat";
    if (previous.length > 0) {
      const diff = latest.reply_rate - avgReplyRate;
      if (diff > 0.5) trend = "up";
      else if (diff < -0.5) trend = "down";
    }

    steps.push({ step, latest, avgReplyRate, avgBounceRate, sparkline, totalSent, totalReplies, trend });
  }

  steps.sort((a, b) => a.step - b.step);
  return steps;
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const width = 80;
  const height = 24;
  const padding = 2;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - ((v - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Dot on the last point */}
      {data.length > 0 && (() => {
        const lastX = padding + ((data.length - 1) / (data.length - 1)) * (width - padding * 2);
        const lastY = height - padding - ((data[data.length - 1] - min) / range) * (height - padding * 2);
        return <circle cx={lastX} cy={lastY} r="2.5" fill={color} />;
      })()}
    </svg>
  );
}

function TrendIcon({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up") return <TrendingUp size={13} className="text-emerald-500" />;
  if (trend === "down") return <TrendingDown size={13} className="text-red-500" />;
  return <Minus size={13} className="text-gray-400" />;
}

export function StepFunnel({ stepMetrics, alerts, campaignName }: StepFunnelProps) {
  const steps = processSteps(stepMetrics);

  if (steps.length === 0) {
    return (
      <Card className="border-border/50 shadow-sm">
        <CardContent className="py-8 text-center">
          <Activity size={24} className="mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No step-level data yet. Data appears after the first sync.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10">
          <Activity size={16} className="text-[#1E8FE8]" />
        </div>
        <div>
          <CardTitle className="text-base">Step Performance</CardTitle>
          {campaignName && <p className="text-xs text-muted-foreground">{campaignName}</p>}
        </div>
      </CardHeader>
      <CardContent>
        {/* Funnel visualization */}
        <div className="space-y-0">
          {steps.map((s, i) => {
            const alert = alerts.find((a) => a.step === s.step);
            const isLast = i === steps.length - 1;
            const sparkColor = s.trend === "down" ? "#ef4444" : s.trend === "up" ? "#10b981" : "#1E8FE8";

            return (
              <div key={s.step}>
                {/* Step row */}
                <div className={`flex items-center gap-4 py-4 ${!isLast ? "border-b border-border/30" : ""}`}>
                  {/* Step number indicator */}
                  <div className="flex flex-col items-center shrink-0 w-10">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                      alert?.severity === "critical"
                        ? "bg-red-100 text-red-700 ring-2 ring-red-500/30"
                        : alert?.severity === "warning"
                        ? "bg-amber-100 text-amber-700 ring-2 ring-amber-500/30"
                        : "bg-[#1E8FE8]/20 text-[#47A5ED]"
                    }`}>
                      {s.step}
                    </div>
                    {!isLast && (
                      <div className="w-px h-4 bg-border/50 mt-1" />
                    )}
                  </div>

                  {/* Metrics */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold">Step {s.step}</span>
                      <TrendIcon trend={s.trend} />
                      {alert && (
                        <Badge
                          variant="secondary"
                          className={`text-[10px] ${
                            alert.severity === "critical"
                              ? "bg-red-100 text-red-700 border border-red-200"
                              : "bg-amber-100 text-amber-700 border border-amber-200"
                          }`}
                        >
                          <AlertTriangle size={9} className="mr-0.5" />
                          {alert.metric === "reply_rate" ? "Reply drop" : "Bounce spike"}
                        </Badge>
                      )}
                    </div>

                    {/* Stats row */}
                    <div className="grid grid-cols-4 gap-3 text-xs">
                      <div>
                        <p className="text-muted-foreground">Reply Rate</p>
                        <p className={`font-bold text-sm ${
                          s.trend === "down" ? "text-red-700" : s.trend === "up" ? "text-emerald-700" : "text-foreground"
                        }`}>
                          {s.latest.reply_rate}%
                        </p>
                        {s.avgReplyRate !== s.latest.reply_rate && (
                          <p className="text-[10px] text-muted-foreground">avg {s.avgReplyRate.toFixed(1)}%</p>
                        )}
                      </div>
                      <div>
                        <p className="text-muted-foreground">Bounce Rate</p>
                        <p className="font-bold text-sm">{s.latest.bounce_rate}%</p>
                        {s.avgBounceRate !== s.latest.bounce_rate && (
                          <p className="text-[10px] text-muted-foreground">avg {s.avgBounceRate.toFixed(1)}%</p>
                        )}
                      </div>
                      <div>
                        <p className="text-muted-foreground">Sent</p>
                        <p className="font-bold text-sm">{s.latest.sent}</p>
                        <p className="text-[10px] text-muted-foreground">{s.totalSent} total</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Replies</p>
                        <p className="font-bold text-sm">{s.latest.unique_replies}</p>
                        <p className="text-[10px] text-muted-foreground">{s.totalReplies} total</p>
                      </div>
                    </div>

                    {/* Alert detail */}
                    {alert && (
                      <div className={`mt-2 rounded-lg px-3 py-2 text-[11px] ${
                        alert.severity === "critical"
                          ? "bg-red-50 text-red-700 border border-red-200"
                          : "bg-amber-50 text-amber-700 border border-amber-200"
                      }`}>
                        {alert.metric === "reply_rate"
                          ? `Reply rate dropped from ${alert.baseline_value}% average to ${alert.current_value}% this period (${alert.change_pct}% change). ${s.latest.sent} emails sent this period.`
                          : `Bounce rate spiked from ${alert.baseline_value}% average to ${alert.current_value}% this period (+${alert.change_pct}% change). ${s.latest.sent} emails sent this period.`
                        }
                      </div>
                    )}
                  </div>

                  {/* Sparkline */}
                  <div className="shrink-0 flex flex-col items-center gap-0.5">
                    <MiniSparkline data={s.sparkline} color={sparkColor} />
                    <p className="text-[9px] text-muted-foreground">{s.sparkline.length}w trend</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
