"use client";

// Campaign builder's placement-probe card. Shows where THIS campaign's copy
// lands in the seed inboxes (Inbox / Promotions / Spam) before any prospect
// sees it. Two modes:
//   • no campaignId (new-campaign builder, not saved yet) → a pure explanatory
//     stub, no fetch.
//   • with campaignId → the latest campaign-copy probe per pool mailbox, or a
//     "no seeds configured" / "not tested yet" stub.
// The run affordance is a link to Admin → Mailboxes (owner-only), where the
// campaign-probe button already lives: this card starts no probes itself.

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FlaskConical } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { useUser } from "@/hooks/use-user";
import { describeCounts, placementStatusLabel, PLACEMENT_FRESHNESS_DAYS } from "@/lib/deliverability/placement";
import type { PlacementTest } from "@/types/app";

interface ProbeStatus {
  seeds_available: number;
  mailboxes: { mailbox_id: string; email: string; test: PlacementTest | null }[];
}

function MailboxesLink({ owner }: { owner: boolean }) {
  if (!owner) return null;
  return (
    <a
      href={appUrl("/admin/mailboxes")}
      className="text-xs font-medium text-[#2E37FE] hover:underline"
    >
      Open Mailboxes →
    </a>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
          <FlaskConical size={16} className="text-white" />
        </div>
        <div>
          <CardTitle className="text-base">Placement probe</CardTitle>
          <p className="text-xs text-muted-foreground">
            See where this campaign&apos;s first email lands (Inbox, Promotions, or Spam) in seed
            inboxes you control, before a prospect ever sees it.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{children}</CardContent>
    </Card>
  );
}

export function CampaignProbeCard({ campaignId }: { campaignId?: string }) {
  const { role } = useUser();
  const owner = role === "owner";
  const [status, setStatus] = useState<ProbeStatus | null>(null);
  const [loading, setLoading] = useState(!!campaignId);

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/probe-status`), {
        cache: "no-store",
      });
      if (res.ok) setStatus((await res.json()) as ProbeStatus);
    } catch {
      /* non-fatal: the card just shows its stub */
    } finally {
      setLoading(false);
    }
  }, [campaignId]);
  useEffect(() => {
    load();
  }, [load]);

  // New-campaign builder: nothing saved yet, pure stub.
  if (!campaignId) {
    return (
      <Shell>
        <p className="text-muted-foreground">
          After you save, LeadStart can send this campaign&apos;s first email to your seed inboxes
          and show where it lands, before any prospect sees it.
        </p>
        <p className="text-xs text-muted-foreground">Seed inboxes live under Admin → Mailboxes.</p>
        <MailboxesLink owner={owner} />
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <p className="text-muted-foreground">Loading placement…</p>
      </Shell>
    );
  }

  if (!status || status.seeds_available === 0) {
    return (
      <Shell>
        <p className="text-muted-foreground">
          No seed inboxes configured: the placement probe can&apos;t run yet. Set them up in Admin →
          Mailboxes → Seed inboxes.
        </p>
        <MailboxesLink owner={owner} />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="divide-y divide-border rounded-lg border">
        {status.mailboxes.map((m) => (
          <div key={m.mailbox_id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate font-medium text-[#0f172a]">{m.email}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{probeSummary(m.test)}</span>
          </div>
        ))}
      </div>
      <MailboxesLink owner={owner} />
    </Shell>
  );
}

function probeSummary(test: PlacementTest | null): string {
  if (!test) return "No probe of this campaign's copy yet.";
  if (test.status === "sending" || test.status === "awaiting") {
    return placementStatusLabel("pending") + "…";
  }
  if (test.status === "failed") return "Last probe didn't complete: try again.";
  // complete
  const summary = describeCounts({
    total: test.seeds_total,
    inbox: test.inbox_count,
    promotions: test.promotions_count,
    spam: test.spam_count,
    missing: test.missing_count,
  });
  const when = test.completed_at ? new Date(test.completed_at) : null;
  const stale = when != null && Date.now() - when.getTime() > PLACEMENT_FRESHNESS_DAYS * 86_400_000;
  const date = when ? when.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  return `${summary}${date ? ` · ${date}` : ""}${stale ? " · outdated, worth re-running" : ""}`;
}
