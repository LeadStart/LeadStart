"use client";

// Client-portal flavor of the LinkedIn campaign view. Strips the
// enrollment-level details (admins see those, clients don't) and shows a
// summary: status, the sequence template, and high-level enrollment
// counts. campaign_snapshots-driven analytics will land later — for now
// a small "Detailed analytics coming soon" note keeps the page honest.

import { use } from "react";
import useSWR from "swr";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KPICard } from "@/components/charts/kpi-card";
import { ArrowLeft, Layers } from "lucide-react";
import type {
  Campaign,
  CampaignEnrollment,
  CampaignStep,
  SequenceStepKind,
} from "@/types/app";

const supabase = createClient();

const KIND_LABELS: Record<SequenceStepKind, string> = {
  connect_request: "Connection request",
  message: "Direct message",
  inmail: "InMail",
  like_post: "Like post",
  profile_visit: "Profile visit",
};

interface FetchResult {
  campaign: Campaign;
  steps: CampaignStep[];
  enrollments: CampaignEnrollment[];
}

async function fetchClientLinkedinCampaign(
  campaignId: string,
): Promise<FetchResult | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();
  if (!campaign) return null;

  const [stepsRes, enrollmentsRes] = await Promise.all([
    supabase
      .from("campaign_steps")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("step_index", { ascending: true }),
    supabase
      .from("campaign_enrollments")
      .select("id, status")
      .eq("campaign_id", campaignId),
  ]);

  return {
    campaign: campaign as Campaign,
    steps: (stepsRes.data ?? []) as CampaignStep[],
    enrollments: (enrollmentsRes.data ?? []) as CampaignEnrollment[],
  };
}

export function LinkedinClientCampaign({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = use(params);
  const { data } = useSWR(`client-linkedin-campaign-${campaignId}`, () =>
    fetchClientLinkedinCampaign(campaignId),
  );

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-32 rounded bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  const { campaign, steps, enrollments } = data;
  const counts = {
    active: enrollments.filter((e) => e.status === "active").length,
    replied: enrollments.filter((e) => e.status === "replied").length,
    completed: enrollments.filter((e) => e.status === "completed").length,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/client"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to Dashboard
        </Link>
        <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a] mt-3" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-2">
              <Badge
                variant="secondary"
                className="bg-[#0A66C2]/10 text-[#0A66C2] border-[#0A66C2]/20"
              >
                LinkedIn
              </Badge>
              <Badge className="bg-white/15 text-[#0f172a] border-0">
                {campaign.status}
              </Badge>
            </div>
            <h1 className="text-2xl font-bold">{campaign.name}</h1>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard label="In progress" value={counts.active} unit="count" />
        <KPICard label="Replied" value={counts.replied} unit="count" />
        <KPICard label="Completed" value={counts.completed} unit="count" />
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0A66C2]">
            <Layers size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Outreach steps</CardTitle>
        </CardHeader>
        <CardContent>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps configured.</p>
          ) : (
            <div className="space-y-2">
              {steps.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-xl border border-border/50 p-3"
                >
                  <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#0A66C2] px-2 text-xs font-bold text-white shrink-0">
                    {s.step_index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-sm">{KIND_LABELS[s.kind]}</span>
                    {s.wait_days > 0 && (
                      <span className="text-xs text-muted-foreground ml-2">
                        wait {s.wait_days} day{s.wait_days === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground italic">
        Detailed daily analytics for LinkedIn campaigns are coming soon. For
        now, the counts above reflect everyone who&apos;s currently in the
        sequence, has replied, or has finished.
      </p>
    </div>
  );
}
