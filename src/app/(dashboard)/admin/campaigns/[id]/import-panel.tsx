"use client";

import { useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  parseCSV,
  rowsWithMapping,
  buildInitialMapping,
  MAPPING_TARGETS,
  type ParsedContactRow,
} from "@/lib/csv/parse-contacts";
import { Button } from "@/components/ui/button";
import {
  FileText,
  UploadCloud,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
  ArrowRight,
} from "lucide-react";
import type { ContactStatus } from "@/types/app";
import { appUrl } from "@/lib/api-url";

interface ImportResult {
  inserted: number;
  linked: number;
  queued: number;
  already_queued: number;
  skipped_no_email: number;
  daily_cap: number | null;
  estimated_drain_days: number | null;
}

export function CampaignImportPanel({
  campaignId,
  campaignName,
  organizationId,
  clientId,
  savedMapping,
}: {
  campaignId: string;
  campaignName: string;
  organizationId: string;
  clientId: string | null;
  savedMapping: Record<string, string> | null;
}) {
  const [filename, setFilename] = useState<string | null>(null);
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [columnMapping, setColumnMapping] = useState<
    Record<string, string>
  >({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const csvHeaders = useMemo(
    () => (grid ? grid[0].map((h) => h.trim()) : []),
    [grid],
  );
  const sampleRow = grid && grid.length > 1 ? grid[1] : [];

  const emailMapped = Object.values(columnMapping).includes("email");

  const rows = useMemo(
    (): ParsedContactRow[] =>
      grid && emailMapped ? rowsWithMapping(grid, columnMapping) : [],
    [grid, columnMapping, emailMapped],
  );

  function reset() {
    setFilename(null);
    setGrid(null);
    setColumnMapping({});
    setParseError(null);
    setImportError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFile(file: File) {
    setParseError(null);
    setImportError(null);
    setResult(null);
    const text = await file.text();
    const parsed = parseCSV(text);
    if (parsed.length < 2) {
      setGrid(null);
      setFilename(null);
      setParseError(
        "CSV must have a header row and at least one data row.",
      );
      return;
    }
    const headers = parsed[0].map((h) => h.trim());
    setFilename(file.name);
    setGrid(parsed);
    setColumnMapping(buildInitialMapping(headers, savedMapping));
  }

  function updateMapping(header: string, target: string) {
    setColumnMapping((prev) => {
      const next = { ...prev };
      if (target) {
        for (const [h, t] of Object.entries(next)) {
          if (h !== header && t === target) {
            next[h] = "";
          }
        }
      }
      next[header] = target;
      return next;
    });
  }

  async function handleImport() {
    if (rows.length === 0) return;
    setImporting(true);
    setImportError(null);
    setResult(null);
    try {
      const supabase = createClient();
      const now = new Date().toISOString();

      // Save the column mapping on the campaign for future re-uploads.
      const activeMapping: Record<string, string> = {};
      for (const [h, t] of Object.entries(columnMapping)) {
        if (t) activeMapping[h] = t;
      }
      await supabase
        .from("campaigns")
        .update({
          csv_column_mapping:
            Object.keys(activeMapping).length > 0 ? activeMapping : null,
          updated_at: now,
        })
        .eq("id", campaignId);

      // ----- 1. Split parsed rows into already-known (by email) vs new.
      const emails = rows.map((r) => r.email.toLowerCase());
      const { data: existingRows, error: existingErr } = await supabase
        .from("contacts")
        .select("id, email")
        .eq("organization_id", organizationId)
        .in("email", emails);
      if (existingErr) {
        setImportError(`Lookup failed: ${existingErr.message}`);
        return;
      }
      const existingByEmail = new Map<string, string>();
      for (const r of (existingRows ?? []) as {
        id: string;
        email: string;
      }[]) {
        existingByEmail.set(r.email.toLowerCase(), r.id);
      }
      const toInsert = rows.filter(
        (r) => !existingByEmail.has(r.email.toLowerCase()),
      );
      const toLink = rows.filter((r) =>
        existingByEmail.has(r.email.toLowerCase()),
      );
      const linkedIds = toLink
        .map((r) => existingByEmail.get(r.email.toLowerCase()))
        .filter((id): id is string => Boolean(id));

      // ----- 2. INSERT new contact rows.
      const insertedIds: string[] = [];
      if (toInsert.length > 0) {
        const payload = toInsert.map((r) => ({
          id: crypto.randomUUID(),
          organization_id: organizationId,
          client_id: clientId,
          campaign_id: campaignId,
          first_name: r.first_name,
          last_name: r.last_name,
          email: r.email,
          company_name: r.company_name,
          title: r.title,
          phone: r.phone,
          linkedin_url: r.linkedin_url,
          intro_line: r.intro_line,
          enrichment_data: {},
          tags: r.tags,
          status: "new" as ContactStatus,
          source: "csv-import-campaign",
          notes: r.notes,
          pipeline_stage: null,
          pipeline_sort_order: 0,
          pipeline_notes: null,
          pipeline_follow_up_date: null,
          pipeline_added_at: null,
          created_at: now,
          updated_at: now,
        }));
        const { data: insertedData, error: insertError } = await supabase
          .from("contacts")
          .insert(payload)
          .select("id");
        if (insertError) {
          setImportError(`Contact insert failed: ${insertError.message}`);
          return;
        }
        for (const r of (insertedData ?? []) as { id: string }[]) {
          insertedIds.push(r.id);
        }
      }

      // ----- 3. UPDATE existing rows to link them to this campaign.
      if (linkedIds.length > 0) {
        const { error: updateError } = await supabase
          .from("contacts")
          .update({ campaign_id: campaignId, updated_at: now })
          .in("id", linkedIds);
        if (updateError) {
          setImportError(
            `Linked-contacts update failed: ${updateError.message}`,
          );
          return;
        }
      }

      const allContactIds = [...insertedIds, ...linkedIds];

      // ----- 4. Queue everything for the daily dispatcher.
      const pushRes = await fetch(
        appUrl("/api/admin/contacts/push-to-campaign"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_ids: allContactIds,
            campaign_id: campaignId,
          }),
        },
      );
      const pushData = (await pushRes.json()) as {
        error?: string;
        queued?: number;
        already_queued?: number;
        skipped_no_email?: number;
        daily_cap?: number;
        estimated_drain_days?: number | null;
      };
      if (!pushRes.ok) {
        setImportError(
          `Contacts saved but queue push failed: ${pushData.error ?? `HTTP ${pushRes.status}`}`,
        );
        return;
      }

      setResult({
        inserted: insertedIds.length,
        linked: linkedIds.length,
        queued: pushData.queued ?? 0,
        already_queued: pushData.already_queued ?? 0,
        skipped_no_email: pushData.skipped_no_email ?? 0,
        daily_cap: pushData.daily_cap ?? null,
        estimated_drain_days: pushData.estimated_drain_days ?? null,
      });
      setFilename(null);
      setGrid(null);
      setColumnMapping({});
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* File picker */}
      <div>
        <label
          htmlFor={`csv-${campaignId}`}
          className="flex items-center gap-3 rounded-lg border-2 border-dashed border-border/60 px-4 py-6 cursor-pointer hover:border-[#2E37FE]/40 hover:bg-[#2E37FE]/5 transition-colors"
        >
          <UploadCloud size={24} className="text-muted-foreground" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              {filename ? filename : "Click to choose a CSV file"}
            </p>
            <p className="text-xs text-muted-foreground">
              {filename
                ? `${csvHeaders.length} columns detected — map them below`
                : "First row should be column headers (email is required)"}
            </p>
          </div>
          {filename && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                reset();
              }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear file"
            >
              <X size={16} />
            </button>
          )}
          <input
            id={`csv-${campaignId}`}
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </label>
      </div>

      {parseError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{parseError}</p>
        </div>
      )}

      {/* Column mapping table */}
      {grid && csvHeaders.length > 0 && (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border/60 flex items-center gap-2">
            <ArrowRight size={12} />
            Map CSV columns to contact fields
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted/20">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  CSV Column
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  Sample Value
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  Map To
                </th>
              </tr>
            </thead>
            <tbody>
              {csvHeaders.map((header, idx) => {
                const sample = sampleRow[idx] ?? "";
                const value = columnMapping[header] ?? "";
                return (
                  <tr key={idx} className="border-t border-border/40">
                    <td className="px-3 py-2 font-medium">{header}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[200px]">
                      {sample || <span className="italic">empty</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={value}
                        onChange={(e) =>
                          updateMapping(header, e.target.value)
                        }
                        disabled={importing}
                        className={`w-full rounded-md border px-2 py-1 text-xs ${
                          value
                            ? "border-[#2E37FE]/30 bg-[#2E37FE]/5"
                            : "border-border/60 bg-background"
                        }`}
                      >
                        <option value="">— Skip —</option>
                        {MAPPING_TARGETS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!emailMapped && (
            <div className="px-3 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-800 flex items-center gap-1.5">
              <AlertCircle size={11} className="shrink-0" />
              At least one column must be mapped to <strong>Email</strong>{" "}
              before importing.
            </div>
          )}
        </div>
      )}

      {/* Preview */}
      {rows.length > 0 && (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border/60 flex items-center gap-2">
            <FileText size={12} />
            Preview (first {Math.min(5, rows.length)} of {rows.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/20">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Company
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Title</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {r.email}
                    </td>
                    <td className="px-3 py-2">
                      {[r.first_name, r.last_name].filter(Boolean).join(" ") ||
                        "—"}
                    </td>
                    <td className="px-3 py-2">{r.company_name || "—"}</td>
                    <td className="px-3 py-2">{r.title || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{importError}</p>
        </div>
      )}

      {result && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <CheckCircle2
            size={16}
            className="text-emerald-600 mt-0.5 shrink-0"
          />
          <div className="text-sm text-emerald-900">
            <p>
              <strong>{result.inserted}</strong> newly inserted,{" "}
              <strong>{result.linked}</strong> already existed and were linked,{" "}
              <strong>{result.queued}</strong> queued for enrollment
              {result.already_queued > 0 && (
                <> ({result.already_queued} were already pending)</>
              )}
              {result.skipped_no_email > 0 && (
                <> · {result.skipped_no_email} skipped (no email)</>
              )}
              .
            </p>
            {result.estimated_drain_days && result.daily_cap ? (
              <p className="text-xs text-emerald-700 mt-1">
                At {result.daily_cap}/day, the cron will finish enrolling these
                in roughly {result.estimated_drain_days} day
                {result.estimated_drain_days === 1 ? "" : "s"}.
              </p>
            ) : null}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Contacts you already uploaded directly in app.salesforge.ai are
        auto-detected by the hourly sync — they&apos;ll appear in the contacts
        table below as <strong>uploaded</strong> without re-enrolling. No
        checkbox needed.
      </p>

      <div className="flex items-center gap-2">
        <Button
          onClick={handleImport}
          disabled={importing || rows.length === 0 || !emailMapped}
        >
          {importing ? (
            <>
              <Loader2 size={14} className="mr-1 animate-spin" /> Importing…
            </>
          ) : (
            <>
              <UploadCloud size={14} className="mr-1" /> Import{" "}
              {rows.length || ""} contact{rows.length === 1 ? "" : "s"}
            </>
          )}
        </Button>
        {grid && !importing && (
          <Button variant="outline" onClick={reset}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
