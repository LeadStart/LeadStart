"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import type { MapsPlace } from "@/types/app";
import {
  TUBE_SKIP_LABEL,
  buildTubeHandoff,
  tubeUploadTable,
  type TubeContactInput,
  type TubeFirmInput,
  type TubeSkipReason,
} from "@/lib/tube/handoff";
import { classifyEmailTier } from "@/lib/enrichment/email-tier";
import { toCsv, downloadCsv } from "@/lib/csv/to-csv";

type ContactRow = TubeContactInput & { google_place_id: string | null };

// "TuBe upload": the exact sheet TuBe SEO's AI-visibility scan takes, built from
// this search's firms joined to their ENRICHED contacts (verified owner email).
// Each row carries the question TuBe asks verbatim (seed_query), the locked
// city + state, and every name the firm goes by, so the scan asks the right
// question and recognises the firm when the AI uses its legal name. Firms that
// can't be emailed, large firms and public bodies are left out, with the reason.
export function TubeExportDialog({
  results,
  selectedIds,
}: {
  results: MapsPlace[];
  selectedIds: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const [onlySelected, setOnlySelected] = useState(false);
  const [includeGeneric, setIncludeGeneric] = useState(false);
  const [contacts, setContacts] = useState<Map<string, ContactRow> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const places = useMemo(
    () =>
      onlySelected && selectedIds.size > 0
        ? results.filter((r) => selectedIds.has(r.google_place_id))
        : results,
    [results, selectedIds, onlySelected],
  );

  // Load the enriched contact behind every place when the dialog opens. A place
  // can map to more than one contact; the one with a verified personal email wins.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        const ids = results.map((r) => r.google_place_id);
        const byPlace = new Map<string, ContactRow>();
        const score = (c: ContactRow) =>
          (classifyEmailTier(c) === "person" && c.email_verification_status === "ok" ? 2 : 0) + (c.first_name ? 1 : 0);
        for (let i = 0; i < ids.length; i += 300) {
          const { data, error: qErr } = await supabase
            .from("contacts")
            .select(
              "google_place_id, first_name, last_name, email, company_email, company_name, email_verification_status, email_verification_subresult, email_kind:enrichment_data->enrichment->email->>kind, email_provider_status:enrichment_data->enrichment->email->>provider_status",
            )
            .in("google_place_id", ids.slice(i, i + 300));
          if (qErr) throw new Error(qErr.message);
          for (const c of (data as unknown as ContactRow[] | null) ?? []) {
            if (!c.google_place_id) continue;
            const prev = byPlace.get(c.google_place_id);
            if (!prev || score(c) > score(prev)) byPlace.set(c.google_place_id, c);
          }
        }
        if (!cancelled) setContacts(byPlace);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load contacts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, results]);

  const handoff = useMemo(() => {
    if (!contacts) return null;
    const firms: TubeFirmInput[] = places.map((p) => ({
      placeName: p.name,
      categories: p.categories ?? [],
      city: p.city,
      state: p.state,
      domain: p.company_domain || p.website,
      contact: contacts.get(p.google_place_id) ?? null,
    }));
    return buildTubeHandoff(firms, { includeGeneric });
  }, [contacts, places, includeGeneric]);

  const skipCounts = useMemo(() => {
    const m = new Map<TubeSkipReason, number>();
    for (const s of handoff?.skipped ?? []) m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [handoff]);

  const stamp = new Date().toISOString().slice(0, 10);
  const downloadUpload = () => {
    if (!handoff) return;
    const { headers, rows } = tubeUploadTable(handoff.rows);
    downloadCsv(`tube-upload-${stamp}.csv`, toCsv(headers, rows));
  };
  const downloadSkipped = () => {
    if (!handoff) return;
    downloadCsv(
      `tube-upload-skipped-${stamp}.csv`,
      toCsv(
        ["firm", "domain", "reason"],
        handoff.skipped.map((s) => [s.name, s.domain, TUBE_SKIP_LABEL[s.reason]]),
      ),
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" className="cursor-pointer" />}>
        <Radar size={14} className="mr-1.5" /> TuBe upload
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>TuBe upload</DialogTitle>
          <DialogDescription>
            The sheet for TuBe&apos;s AI-visibility scan: one row per firm with a verified owner email, the exact
            question to ask (&ldquo;Who are the best personal injury lawyers in Tacoma, WA?&rdquo;) and every name the
            firm goes by. Upload it in TuBe → Admin → Prospecting.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Matching firms to their enriched contacts…
          </div>
        )}
        {error && <p className="py-2 text-sm text-red-600">{error}</p>}

        {handoff && !loading && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="text-2xl font-semibold tabular-nums">{handoff.rows.length}</div>
              <div className="text-xs text-muted-foreground">
                of {places.length} {places.length === 1 ? "firm" : "firms"} ready for TuBe (about $
                {(handoff.rows.length * 0.034).toFixed(2)} to scan, Google only)
              </div>
            </div>

            {skipCounts.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Left out</p>
                <ul className="space-y-0.5 text-sm">
                  {skipCounts.map(([reason, n]) => (
                    <li key={reason} className="flex justify-between gap-4">
                      <span>{TUBE_SKIP_LABEL[reason]}</span>
                      <span className="tabular-nums text-muted-foreground">{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {handoff.genericCount > 0 && (
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeGeneric}
                  onChange={(e) => setIncludeGeneric(e.target.checked)}
                  className="mt-0.5 cursor-pointer"
                />
                <span>
                  Include {handoff.genericCount} {handoff.genericCount === 1 ? "firm" : "firms"} with no specific
                  practice area
                  <span className="block text-xs text-muted-foreground">
                    They&apos;d be asked the broad question (&ldquo;best lawyers in Olympia&rdquo;), a weaker hook.
                  </span>
                </span>
              </label>
            )}
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {selectedIds.size > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={onlySelected}
                  onChange={(e) => setOnlySelected(e.target.checked)}
                  className="cursor-pointer"
                />
                Only selected ({selectedIds.size})
              </label>
            )}
            {handoff && handoff.skipped.length > 0 && (
              <button type="button" onClick={downloadSkipped} className="cursor-pointer underline underline-offset-2">
                Skipped list
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <DialogClose render={<Button size="sm" variant="outline" className="cursor-pointer" />}>
              Cancel
            </DialogClose>
            <Button
              size="sm"
              onClick={downloadUpload}
              disabled={!handoff || handoff.rows.length === 0 || loading}
              className="cursor-pointer"
            >
              <Download size={14} className="mr-1.5" /> Download
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
