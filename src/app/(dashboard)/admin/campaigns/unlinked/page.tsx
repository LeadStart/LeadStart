"use client";

import { useState } from "react";
import Link from "next/link";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import {
  ADMIN_UNLINKED_CAMPAIGNS_KEY,
  fetchAdminUnlinkedCampaigns,
  type UnlinkedCampaignRow,
} from "@/lib/admin-queries";
import { ORPHAN_CAMPAIGN_COUNT_KEY } from "@/hooks/use-orphan-campaign-count";
import { useSWRConfig } from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link2, Mail, ArrowLeft, Sparkles } from "lucide-react";
import type { Client } from "@/types/app";
import { appUrl } from "@/lib/api-url";

export default function UnlinkedCampaignsPage() {
  const { data, loading, refetch } = useSupabaseQuery(
    ADMIN_UNLINKED_CAMPAIGNS_KEY,
    fetchAdminUnlinkedCampaigns,
  );

  const rows = data?.rows ?? [];
  const clients = data?.clients ?? [];

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[#64748b]">
              Campaign Triage
            </p>
            <h1
              className="text-[20px] sm:text-[22px] font-bold mt-1"
              style={{ color: "#0f172a", letterSpacing: "-0.01em" }}
            >
              Unlinked Campaigns
            </h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              {rows.length === 0 ? (
                <>No orphan campaigns — everything is assigned to a client.</>
              ) : (
                <>
                  {rows.length} orphan{rows.length === 1 ? "" : "s"} awaiting
                  client assignment. Pending replies fire notifications the
                  moment you link.
                </>
              )}
            </p>
          </div>
          <Link
            href="/admin/campaigns"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[#0f172a]/70 hover:text-[#2E37FE] transition-colors"
          >
            <ArrowLeft size={14} />
            All campaigns
          </Link>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Orphan campaigns appear here when the Instantly sync imports a
              campaign that isn&apos;t linked to a client yet. Run{" "}
              <Link
                href="/admin/campaigns"
                className="underline hover:text-[#2E37FE]"
              >
                Sync from Instantly
              </Link>{" "}
              to check for new ones.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Instantly ID</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead>Link to client</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <UnlinkedRow
                    key={row.campaign.id}
                    row={row}
                    clients={clients}
                    onLinked={refetch}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UnlinkedRow({
  row,
  clients,
  onLinked,
}: {
  row: UnlinkedCampaignRow;
  clients: Client[];
  onLinked: () => void;
}) {
  const { campaign, pending_notifications, total_orphan_replies } = row;
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [linking, setLinking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const { mutate } = useSWRConfig();

  // Filter picker options to clients in the same organization_id as this
  // campaign. Server enforces the same check; this is the UX layer.
  const eligible = clients.filter(
    (c) => c.organization_id === campaign.organization_id,
  );
  // Internal pseudo-clients pin to the top of the picker so LeadStart's own
  // marketing outreach is always one click away (migration 00048).
  const internalEligible = eligible.filter((c) => c.is_internal);
  const regularEligible = eligible.filter((c) => !c.is_internal);

  async function handleLink() {
    if (!selectedClientId) return;
    setLinking(true);
    setResult(null);
    setIsError(false);
    try {
      const res = await fetch(appUrl(`/api/campaigns/${campaign.id}/link-client`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: selectedClientId }),
      });
      const json = (await res.json()) as {
        error?: string;
        replies_updated?: number;
        notifications_queued?: number;
        pipeline_runs_queued?: number;
      };
      if (!res.ok) {
        throw new Error(json.error || `Link failed (${res.status})`);
      }
      const notifs = json.notifications_queued ?? 0;
      const pipe = json.pipeline_runs_queued ?? 0;
      const replies = json.replies_updated ?? 0;
      const parts = [`Linked · ${replies} repl${replies === 1 ? "y" : "ies"} updated`];
      if (notifs > 0) parts.push(`${notifs} notification${notifs === 1 ? "" : "s"} queued`);
      if (pipe > 0) parts.push(`${pipe} pipeline run${pipe === 1 ? "" : "s"} queued`);
      setResult(parts.join(" · "));
      // Bust the sidebar badge so it drops immediately.
      mutate(ORPHAN_CAMPAIGN_COUNT_KEY);
      onLinked();
    } catch (err) {
      setIsError(true);
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  }

  const pendingLabel =
    total_orphan_replies > pending_notifications
      ? `${pending_notifications} (${total_orphan_replies} total)`
      : String(pending_notifications);

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
            style={{ background: "#2E37FE" }}
          >
            <Mail size={14} />
          </div>
          <div className="flex flex-col">
            <span className="font-medium text-foreground">{campaign.name}</span>
            <Badge variant="secondary" className="badge-amber w-fit mt-1">
              Unlinked
            </Badge>
          </div>
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {campaign.instantly_campaign_id}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {new Date(campaign.created_at).toLocaleDateString()}
      </TableCell>
      <TableCell className="text-right">
        {pending_notifications > 0 ? (
          <span className="font-medium text-amber-700">{pendingLabel}</span>
        ) : total_orphan_replies > 0 ? (
          <span className="text-muted-foreground">{pendingLabel}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Select
              value={selectedClientId}
              onValueChange={(v) => setSelectedClientId(v ?? "")}
            >
              <SelectTrigger className="h-9 min-w-[200px] text-sm bg-white">
                <SelectValue placeholder="Choose a client…">
                  {(value) => {
                    if (typeof value !== "string" || !value)
                      return "Choose a client…";
                    return (
                      eligible.find((c) => c.id === value)?.name ?? value
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {eligible.length === 0 ? (
                  <SelectItem value="__none" disabled>
                    No clients in this organization
                  </SelectItem>
                ) : (
                  <>
                    {internalEligible.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <Sparkles
                            size={12}
                            className="text-[#2E37FE] shrink-0"
                          />
                          <span>{c.name}</span>
                          <span className="ml-1 rounded-md bg-[#2E37FE]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#2E37FE]">
                            Internal
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                    {internalEligible.length > 0 &&
                      regularEligible.length > 0 && (
                        <div
                          role="separator"
                          className="my-1 h-px bg-border"
                        />
                      )}
                    {regularEligible.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </>
                )}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleLink}
              disabled={!selectedClientId || linking}
              className="gap-1.5 text-[#f8fafc]"
            >
              <Link2 size={14} className={linking ? "animate-pulse" : ""} />
              {linking ? "Linking…" : "Link"}
            </Button>
          </div>
          {result && (
            <p
              className={`text-xs ${
                isError ? "text-red-600" : "text-muted-foreground"
              }`}
            >
              {result}
            </p>
          )}
        </div>
      </TableCell>
      <TableCell />
    </TableRow>
  );
}
