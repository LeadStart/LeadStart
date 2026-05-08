// GET /api/admin/salesforge/inbox
//
// Composite endpoint that returns everything the Salesforge inbox page
// needs in one round-trip:
//   - threads (filterable; same query params as Salesforge's /threads)
//   - labels (for the per-thread label picker)
//   - mailboxes (for the mailbox filter dropdown)
//
// Owner-only. Query params (all optional): limit, offset, mailbox_ids[],
// sequence_ids[], labels[], exclude_labels[], q (search), positive,
// filter.

import { NextRequest, NextResponse } from "next/server";
import {
  resolveSalesforgeOwnerContext,
  callSalesforge,
} from "@/lib/salesforge/route-helpers";
import type { SalesforgeThreadsListParams } from "@/lib/salesforge/types";

export async function GET(req: NextRequest) {
  const r = await resolveSalesforgeOwnerContext();
  if (!r.ok) return r.response;

  const sp = req.nextUrl.searchParams;
  const params: SalesforgeThreadsListParams = {
    limit: sp.get("limit") ? Number(sp.get("limit")) : 50,
    offset: sp.get("offset") ? Number(sp.get("offset")) : 0,
    q: sp.get("q") || undefined,
    filter: sp.get("filter") || undefined,
    positive:
      sp.get("positive") === "true"
        ? true
        : sp.get("positive") === "false"
          ? false
          : undefined,
    mailboxIds: sp.getAll("mailbox_ids[]"),
    sequenceIds: sp.getAll("sequence_ids[]"),
    labels: sp.getAll("labels[]"),
    excludeLabels: sp.getAll("exclude_labels[]"),
  };

  // Run all three list calls in parallel — they're independent.
  const [threads, labels, mailboxes] = await Promise.all([
    callSalesforge("listThreads", () => r.ctx.client.listThreads(r.ctx.workspaceId, params)),
    callSalesforge("listPrimeboxLabels", () => r.ctx.client.listPrimeboxLabels(r.ctx.workspaceId)),
    callSalesforge("listMailboxes", () => r.ctx.client.listMailboxes(r.ctx.workspaceId)),
  ]);

  // If threads failed, return its error — the page can't render
  // without that. Labels + mailboxes are best-effort (degrade to []).
  if (!threads.ok) return threads.response;

  return NextResponse.json({
    threads: threads.data,
    labels: labels.ok ? labels.data : [],
    mailboxes: mailboxes.ok ? mailboxes.data : [],
  });
}
