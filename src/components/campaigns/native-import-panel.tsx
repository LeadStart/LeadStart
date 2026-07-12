"use client";

// CSV import panel for NATIVE EMAIL campaigns, mounted on both the client
// portal and the admin campaign detail page. Unlike the admin Salesforge
// panel (admin/campaigns/[id]/import-panel.tsx, whose mapping-table/preview
// structure this copies), every read and write goes through
// /api/campaigns/[id]/client-import — no direct browser Supabase access, so
// it works for client-role users after the contacts RLS lockdown.
//
// Mapping targets are campaign-aware: the standard contact fields PLUS the
// {{tokens}} this campaign's templates actually use (fetched from the GET
// bootstrap). Custom tokens map into contacts.custom_fields via the
// "custom:<Token>" target namespace.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseCSV,
  rowsWithMappingAndCustom,
  buildInitialMappingForTargets,
  MAPPING_TARGETS,
  CUSTOM_TARGET_PREFIX,
  type ParsedContactRowWithCustom,
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
import { appUrl } from "@/lib/api-url";

interface CampaignTokens {
  standard: { token: string; key: string; fields: string[] }[];
  custom: { token: string; key: string }[];
}

interface Bootstrap {
  campaign: { id: string; name: string; status: string };
  tokens: CampaignTokens;
  saved_mapping: Record<string, string> | null;
  max_rows: number;
}

interface ImportResult {
  inserted: number;
  linked: number;
  enrolled: number;
  already_enrolled: number;
  skipped_invalid_email: number;
  skipped_existing_elsewhere: number;
  skipped_dnc: number;
  skipped_suppressed: number;
  in_file_duplicates: number;
  total_received: number;
}

export function NativeImportPanel({ campaignId }: { campaignId: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const [filename, setFilename] = useState<string | null>(null);
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          appUrl(`/api/campaigns/${campaignId}/client-import`),
        );
        const data = (await res.json()) as Bootstrap & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setBootstrapError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setBootstrap(data);
      } catch (err) {
        if (!cancelled) {
          setBootstrapError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const maxRows = bootstrap?.max_rows ?? 500;
  const customTokens = useMemo(
    () => bootstrap?.tokens.custom ?? [],
    [bootstrap],
  );

  const csvHeaders = useMemo(
    () => (grid ? grid[0].map((h) => h.trim()) : []),
    [grid],
  );
  const sampleRow = grid && grid.length > 1 ? grid[1] : [];

  const emailMapped = Object.values(columnMapping).includes("email");

  const rows = useMemo(
    (): ParsedContactRowWithCustom[] =>
      grid && emailMapped ? rowsWithMappingAndCustom(grid, columnMapping) : [],
    [grid, columnMapping, emailMapped],
  );

  // Campaign variables with no CSV column mapped to them (advisory — a
  // missing token renders literally at send time, and linked contacts may
  // already carry the value).
  const unmappedCustom = useMemo(() => {
    const mapped = new Set(Object.values(columnMapping));
    return customTokens.filter(
      (t) => !mapped.has(CUSTOM_TARGET_PREFIX + t.token),
    );
  }, [customTokens, columnMapping]);

  // Standard tokens the templates use whose backing contact field has no
  // mapped column — those render BLANK at send time (buildTokenMap falls
  // back to "" for missing standard fields).
  const unmappedStandard = useMemo(() => {
    if (!bootstrap) return [];
    const mapped = new Set(Object.values(columnMapping));
    return bootstrap.tokens.standard.filter(
      (t) => !t.fields.some((f) => mapped.has(f)),
    );
  }, [bootstrap, columnMapping]);

  // Custom-variable columns to show in the preview (up to 3).
  const previewCustomKeys = useMemo(() => {
    const keys: string[] = [];
    for (const target of Object.values(columnMapping)) {
      if (target.startsWith(CUSTOM_TARGET_PREFIX)) {
        keys.push(target.slice(CUSTOM_TARGET_PREFIX.length));
        if (keys.length >= 3) break;
      }
    }
    return keys;
  }, [columnMapping]);

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
      setParseError("CSV must have a header row and at least one data row.");
      return;
    }
    if (parsed.length - 1 > maxRows) {
      setGrid(null);
      setFilename(null);
      setParseError(
        `This file has ${parsed.length - 1} rows — the limit is ${maxRows} per upload. Split the file and upload the parts one at a time.`,
      );
      return;
    }
    const headers = parsed[0].map((h) => h.trim());
    setFilename(file.name);
    setGrid(parsed);
    setColumnMapping(
      buildInitialMappingForTargets(
        headers,
        bootstrap?.saved_mapping ?? null,
        customTokens,
      ),
    );
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
      const activeMapping: Record<string, string> = {};
      for (const [h, t] of Object.entries(columnMapping)) {
        if (t) activeMapping[h] = t;
      }
      const res = await fetch(
        appUrl(`/api/campaigns/${campaignId}/client-import`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rows,
            column_mapping: activeMapping,
            filename,
          }),
        },
      );
      const data = (await res.json()) as ImportResult & { error?: string };
      if (!res.ok) {
        setImportError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data);
      // The server just persisted this mapping; keep the local bootstrap in
      // sync so a second upload in the same session pre-fills from it rather
      // than the now-stale mapping captured at mount.
      setBootstrap((b) => (b ? { ...b, saved_mapping: activeMapping } : b));
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

  if (bootstrapError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
        <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
        <p className="text-sm text-red-700">
          Could not load the import panel: {bootstrapError}
        </p>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={14} className="animate-spin" /> Loading import panel…
      </div>
    );
  }

  if (bootstrap.campaign.status !== "active") {
    return (
      <p className="text-sm text-muted-foreground py-2">
        Contacts can be added once this campaign is active.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* File picker */}
      <div>
        <label
          htmlFor={`native-csv-${campaignId}`}
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
                : `First row should be column headers (email is required, up to ${maxRows} rows)`}
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
            id={`native-csv-${campaignId}`}
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
            Map CSV columns to contact fields and campaign variables
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted/20">
              <tr>
                <th className="px-3 py-2 text-left font-medium">CSV Column</th>
                <th className="px-3 py-2 text-left font-medium">
                  Sample Value
                </th>
                <th className="px-3 py-2 text-left font-medium">Map To</th>
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
                        onChange={(e) => updateMapping(header, e.target.value)}
                        disabled={importing}
                        className={`w-full rounded-md border px-2 py-1 text-xs ${
                          value
                            ? "border-[#2E37FE]/30 bg-[#2E37FE]/5"
                            : "border-border/60 bg-background"
                        }`}
                      >
                        <option value="">— Skip —</option>
                        <optgroup label="Contact fields">
                          {MAPPING_TARGETS.map((f) => (
                            <option key={f.value} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </optgroup>
                        {customTokens.length > 0 && (
                          <optgroup label="Campaign variables">
                            {customTokens.map((t) => (
                              <option
                                key={t.key}
                                value={CUSTOM_TARGET_PREFIX + t.token}
                              >
                                {"{{"}
                                {t.token}
                                {"}}"}
                              </option>
                            ))}
                          </optgroup>
                        )}
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
          {emailMapped && unmappedCustom.length > 0 && (
            <div className="px-3 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-800 flex items-center gap-1.5">
              <AlertCircle size={11} className="shrink-0" />
              <span>
                This campaign&apos;s emails use{" "}
                {unmappedCustom.map((t, i) => (
                  <span key={t.key}>
                    {i > 0 && ", "}
                    <strong>
                      {"{{"}
                      {t.token}
                      {"}}"}
                    </strong>
                  </span>
                ))}{" "}
                but no column is mapped to{" "}
                {unmappedCustom.length === 1 ? "it" : "them"} — contacts
                without a value will show the raw placeholder.
              </span>
            </div>
          )}
          {emailMapped && unmappedStandard.length > 0 && (
            <div className="px-3 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-800 flex items-center gap-1.5">
              <AlertCircle size={11} className="shrink-0" />
              <span>
                The emails also personalize with{" "}
                {unmappedStandard.map((t, i) => (
                  <span key={t.key}>
                    {i > 0 && ", "}
                    <strong>
                      {"{{"}
                      {t.token}
                      {"}}"}
                    </strong>
                  </span>
                ))}{" "}
                — with no column mapped, those spots will be blank for new
                contacts.
              </span>
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
                  <th className="px-3 py-2 text-left font-medium">Company</th>
                  {previewCustomKeys.map((k) => (
                    <th key={k} className="px-3 py-2 text-left font-medium">
                      {"{{"}
                      {k}
                      {"}}"}
                    </th>
                  ))}
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
                    {previewCustomKeys.map((k) => (
                      <td key={k} className="px-3 py-2">
                        {r.custom_fields[k] || "—"}
                      </td>
                    ))}
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

      {result &&
        (() => {
          const added = result.inserted + result.linked;
          // Green only when contacts were actually added/enrolled; otherwise a
          // neutral amber banner so an all-skipped upload doesn't read as a win.
          const tone =
            added > 0
              ? { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-900", foot: "text-emerald-700" }
              : { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-900", foot: "text-amber-700" };
          return (
            <div
              className={`flex items-start gap-2 rounded-lg border ${tone.border} ${tone.bg} p-3`}
            >
              {added > 0 ? (
                <CheckCircle2 size={16} className="text-emerald-600 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle size={16} className="text-amber-600 mt-0.5 shrink-0" />
              )}
              <div className={`text-sm ${tone.text}`}>
                <p>
                  <strong>{result.inserted}</strong> new contact
                  {result.inserted === 1 ? "" : "s"} added,{" "}
                  <strong>{result.linked}</strong> already existed and were
                  added to this campaign, <strong>{result.enrolled}</strong>{" "}
                  enrolled for sending
                  {result.already_enrolled > 0 && (
                    <> ({result.already_enrolled} were already enrolled)</>
                  )}
                  {result.skipped_invalid_email > 0 && (
                    <> · {result.skipped_invalid_email} skipped (invalid email)</>
                  )}
                  {result.in_file_duplicates > 0 && (
                    <> · {result.in_file_duplicates} duplicate rows collapsed</>
                  )}
                  {result.skipped_dnc > 0 && (
                    <> · {result.skipped_dnc} skipped (do-not-contact list)</>
                  )}
                  {result.skipped_suppressed > 0 && (
                    <>
                      {" "}
                      · {result.skipped_suppressed} skipped (previously bounced,
                      unsubscribed, or replied)
                    </>
                  )}
                  {result.skipped_existing_elsewhere > 0 && (
                    <>
                      {" "}
                      · {result.skipped_existing_elsewhere} skipped (already in
                      the system)
                    </>
                  )}
                  .
                </p>
                {added > 0 && (
                  <p className={`text-xs ${tone.foot} mt-1`}>
                    Sending starts automatically within ~15 minutes, during this
                    campaign&apos;s sending window.
                  </p>
                )}
              </div>
            </div>
          );
        })()}

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
