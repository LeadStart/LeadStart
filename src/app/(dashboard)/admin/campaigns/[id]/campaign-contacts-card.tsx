"use client";

// "Contacts in this campaign": every contact assigned to the campaign
// (contacts.campaign_id) with its sequence-enrollment state. Assignment and
// enrollment are separate facts: the dispatcher sends exclusively off
// campaign_enrollments, so an assigned-but-unenrolled contact never receives
// a step. This card is where that gap becomes visible, and fixable via the
// Enroll button, which upserts the missing enrollments through the existing
// /api/admin/campaigns/[id]/enroll endpoint (idempotent, skips contacts with
// a cached undeliverable email verdict).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Users, Send, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { verificationBadge } from "@/lib/millionverifier/labels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EmailVerificationStatus } from "@/types/app";

const PAGE_SIZE = 25;
const ENROLL_CHUNK = 500; // the enroll endpoint's per-request cap

export type CampaignContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_verification_status: EmailVerificationStatus | null;
  company_name: string | null;
  title: string | null;
  created_at: string;
  enrollment: { status: string; current_step_index: number | null } | null;
};

function enrollmentBadge(e: CampaignContactRow["enrollment"]): {
  label: string;
  className: string;
} {
  if (!e) return { label: "Not enrolled", className: "badge-amber" };
  switch (e.status) {
    case "active":
      return {
        label: `In sequence · step ${(e.current_step_index ?? 0) + 1}`,
        className: "badge-green",
      };
    case "completed":
      return { label: "Sequence finished", className: "badge-slate" };
    case "replied":
      return { label: "Replied", className: "badge-green" };
    case "failed":
      return { label: "Failed", className: "badge-red" };
    default:
      return { label: e.status, className: "badge-slate" };
  }
}

export function CampaignContactsCard({
  campaignId,
  contacts,
  truncated,
  canEnroll,
}: {
  campaignId: string;
  contacts: CampaignContactRow[];
  truncated: boolean;
  // True for channels whose sequences run off campaign_enrollments
  // (native email + LinkedIn): the only ones the enroll endpoint accepts.
  canEnroll: boolean;
}) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [enrolling, setEnrolling] = useState(false);

  const enrolledCount = contacts.filter((c) => c.enrollment).length;
  const notEnrolled = contacts.filter((c) => !c.enrollment);

  const totalPages = Math.max(1, Math.ceil(contacts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = contacts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function handleEnroll() {
    if (notEnrolled.length === 0 || enrolling) return;
    setEnrolling(true);
    try {
      let enrolled = 0;
      let skippedUndeliverable = 0;
      const ids = notEnrolled.map((c) => c.id);
      for (let i = 0; i < ids.length; i += ENROLL_CHUNK) {
        const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/enroll`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_ids: ids.slice(i, i + ENROLL_CHUNK) }),
        });
        const data = (await res.json()) as {
          enrolled?: number;
          skipped_undeliverable?: number;
          error?: string;
        };
        if (!res.ok) {
          toast.error(data.error ?? `Enroll failed (${res.status})`);
          return;
        }
        enrolled += data.enrolled ?? 0;
        skippedUndeliverable += data.skipped_undeliverable ?? 0;
      }
      toast.success(
        `Enrolled ${enrolled} contact${enrolled === 1 ? "" : "s"} into the sequence` +
          (skippedUndeliverable > 0
            ? `: ${skippedUndeliverable} skipped (undeliverable email)`
            : ""),
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setEnrolling(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
          <Users size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base">Contacts in this campaign</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {contacts.length}
            {truncated ? "+" : ""} assigned · {enrolledCount} in the sequence
            {notEnrolled.length > 0 ? ` · ${notEnrolled.length} not enrolled yet` : ""}
          </p>
        </div>
        {canEnroll && notEnrolled.length > 0 && (
          <Button size="sm" onClick={handleEnroll} disabled={enrolling} className="gap-1.5">
            {enrolling ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            {enrolling
              ? "Enrolling…"
              : `Enroll ${notEnrolled.length} into sequence`}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No contacts assigned yet. Import a CSV above, or save sourced people
            from Prospecting with this campaign selected.
          </p>
        ) : (
          <>
            {canEnroll && notEnrolled.length > 0 && (
              <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                Assigned contacts are only emailed once they&apos;re enrolled in
                the sequence: the {notEnrolled.length} not-enrolled contact
                {notEnrolled.length === 1 ? "" : "s"} below will not receive
                any steps until you enroll them.
              </p>
            )}
            {/* Mobile: stacked cards, no sideways-scrolling table */}
            <div className="space-y-2.5 lg:hidden">
              {pageRows.map((c) => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
                const vb = verificationBadge(c.email_verification_status);
                const eb = enrollmentBadge(c.enrollment);
                return (
                  <div key={c.id} className="rounded-xl border border-border bg-card p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-foreground truncate">{name}</p>
                      <Badge variant="secondary" className={`${eb.className} text-[10px] shrink-0`}>{eb.label}</Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                      <span className="truncate">{c.email ?? "no email yet"}</span>
                      {vb && <Badge variant="secondary" className={`${vb.className} text-[10px] shrink-0`}>{vb.label}</Badge>}
                    </div>
                    {(c.company_name || c.title) && (
                      <p className="mt-1 text-xs text-muted-foreground truncate">
                        {c.company_name || "—"}{c.title ? ` · ${c.title}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Desktop: full table */}
            <div className="hidden lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="hidden md:table-cell">Company</TableHead>
                  <TableHead className="hidden lg:table-cell">Title</TableHead>
                  <TableHead>Sequence</TableHead>
                  <TableHead className="text-right">Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((c) => {
                  const name =
                    [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
                  const vb = verificationBadge(c.email_verification_status);
                  const eb = enrollmentBadge(c.enrollment);
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          {c.email ?? <span className="text-xs">no email yet</span>}
                          {vb && (
                            <Badge
                              variant="secondary"
                              className={`${vb.className} text-[10px]`}
                            >
                              {vb.label}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {c.company_name || "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground max-w-[220px] truncate">
                        {c.title || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={`${eb.className} text-[10px]`}>
                          {eb.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-xs whitespace-nowrap">
                        {new Date(c.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
            <PaginationControls
              currentPage={safePage}
              totalItems={contacts.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
            {truncated && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Showing the {contacts.length} most recently added contacts.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
