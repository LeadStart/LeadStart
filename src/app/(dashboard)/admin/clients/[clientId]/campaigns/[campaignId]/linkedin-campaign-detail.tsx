"use client";

// LinkedIn flavor of the admin campaign detail page. Used when
// campaign.source_channel === 'linkedin'. The email path keeps the daily
// chart + step funnel (campaign_snapshots data); LinkedIn campaigns
// don't sync to those tables yet, so this component shows
// enrollment-derived KPIs plus the sequence template and an enrollment
// table — the things an operator actually wants to see for a sequence in
// flight.

import { use } from "react";
import useSWR from "swr";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KPICard } from "@/components/charts/kpi-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft, Layers, Users } from "lucide-react";
import type {
  Campaign,
  CampaignEnrollment,
  CampaignStep,
  Contact,
  EnrollmentStatus,
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

const STATUS_BADGE: Record<EnrollmentStatus, string> = {
  active: "badge-green",
  paused: "badge-amber",
  completed: "badge-slate",
  replied: "badge-blue",
  failed: "badge-red",
};

interface FetchResult {
  campaign: Campaign;
  steps: CampaignStep[];
  enrollments: Array<CampaignEnrollment & { contact: Contact | null }>;
  clientName: string;
}

async function fetchLinkedinCampaign(
  campaignId: string,
): Promise<FetchResult | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();
  if (!campaign) return null;
  const typedCampaign = campaign as Campaign;

  const { data: clientData } = typedCampaign.client_id
    ? await supabase
        .from("clients")
        .select("name")
        .eq("id", typedCampaign.client_id)
        .single()
    : { data: null };

  const [stepsRes, enrollmentsRes] = await Promise.all([
    supabase
      .from("campaign_steps")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("step_index", { ascending: true }),
    supabase
      .from("campaign_enrollments")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const steps = (stepsRes.data ?? []) as CampaignStep[];
  const enrollments = (enrollmentsRes.data ?? []) as CampaignEnrollment[];

  // Bulk-fetch contacts for the enrollment list.
  const contactIds = enrollments.map((e) => e.contact_id);
  const { data: contactsData } = contactIds.length
    ? await supabase.from("contacts").select("*").in("id", contactIds)
    : { data: [] };
  const contactMap = new Map(
    ((contactsData ?? []) as Contact[]).map((c) => [c.id, c]),
  );

  return {
    campaign: typedCampaign,
    steps,
    enrollments: enrollments.map((e) => ({
      ...e,
      contact: contactMap.get(e.contact_id) ?? null,
    })),
    clientName:
      ((clientData as { name: string } | null)?.name as string | undefined) ??
      "Unknown",
  };
}

export function LinkedinCampaignDetail({
  params,
}: {
  params: Promise<{ clientId: string; campaignId: string }>;
}) {
  const { clientId, campaignId } = use(params);
  const { data } = useSWR(`admin-linkedin-campaign-${campaignId}`, () =>
    fetchLinkedinCampaign(campaignId),
  );

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 rounded bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  const { campaign, steps, enrollments } = data;

  const counts = {
    active: enrollments.filter((e) => e.status === "active").length,
    replied: enrollments.filter((e) => e.status === "replied").length,
    completed: enrollments.filter((e) => e.status === "completed").length,
    failed: enrollments.filter((e) => e.status === "failed").length,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/clients/${clientId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to Client
        </Link>
        <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a] mt-3" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
          <div className="relative z-10 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Badge
                  variant="secondary"
                  className="bg-[#0A66C2]/10 text-[#0A66C2] border-[#0A66C2]/20"
                >
                  LinkedIn
                </Badge>
                <h1 className="text-2xl font-bold">{campaign.name}</h1>
              </div>
              {campaign.unipile_account_id && (
                <p className="text-xs text-[#0f172a]/50 font-mono mt-1">
                  account: {campaign.unipile_account_id}
                </p>
              )}
            </div>
            <Badge
              className={
                campaign.status === "active"
                  ? "bg-white/15 text-[#0f172a] border-0"
                  : "bg-white/10 text-[#0f172a]/60 border-0"
              }
            >
              {campaign.status}
            </Badge>
          </div>
          <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard label="Active enrollments" value={counts.active} unit="count" />
        <KPICard label="Replied" value={counts.replied} unit="count" />
        <KPICard label="Completed" value={counts.completed} unit="count" />
        <KPICard label="Failed" value={counts.failed} unit="count" />
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0A66C2]">
            <Layers size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Sequence ({steps.length} steps)</CardTitle>
        </CardHeader>
        <CardContent>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps configured.</p>
          ) : (
            <div className="space-y-2">
              {steps.map((s) => (
                <div
                  key={s.id}
                  className="flex items-start gap-3 rounded-xl border border-border/50 p-3"
                >
                  <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#0A66C2] px-2 text-xs font-bold text-white shrink-0">
                    {s.step_index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{KIND_LABELS[s.kind]}</span>
                      {s.wait_days > 0 && (
                        <span className="text-xs text-muted-foreground">
                          · wait {s.wait_days}d
                        </span>
                      )}
                    </div>
                    {s.body_template && (
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                        {s.body_template}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0A66C2]">
            <Users size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">
            Enrollments ({enrollments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {enrollments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contacts enrolled yet. Use the enroll API to add contacts to this sequence.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last action</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {enrollments.slice(0, 50).map((e) => {
                  const name =
                    e.contact &&
                    [e.contact.first_name, e.contact.last_name]
                      .filter(Boolean)
                      .join(" ");
                  return (
                    <TableRow key={e.id}>
                      <TableCell>
                        <div className="text-sm font-medium">
                          {name || e.contact?.email || "(unknown)"}
                        </div>
                        {e.contact?.linkedin_url && (
                          <a
                            href={e.contact.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-[#0A66C2] hover:underline truncate"
                          >
                            {e.contact.linkedin_url}
                          </a>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {e.current_step_index + 1} / {steps.length}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={STATUS_BADGE[e.status]}>
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.last_action_at
                          ? new Date(e.last_action_at).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                        {e.last_error ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
