"use client";

// CSV import panel for NATIVE EMAIL campaigns, mounted on both the client
// portal and the admin campaign detail page. Every read and write goes
// through /api/campaigns/[id]/client-import — no direct browser Supabase
// access, so it works for client-role users after the contacts RLS lockdown.
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
import { normalizeVarKey } from "@/lib/native/tokens";
import { Button } from "@/components/ui/button";
import {
  FileText,
  UploadCloud,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
  Check,
  ArrowRight,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface CampaignTokens {
  standard: { token: string; key: string; fields: string[]; hasFallback: boolean }[];
  custom: { token: string; key: string; hasFallback: boolean }[];
}

interface CampaignVariable {
  token: string;
  key: string;
  kind: "standard" | "custom";
  fields?: string[];
}

interface Bootstrap {
  campaign: { id: string; name: string; status: string };
  tokens: CampaignTokens;
  // The persisted variable registry (migration 00092): every variable the
  // campaign knows about (copy tokens + previously-mapped list columns).
  variables: CampaignVariable[];
  saved_mapping: Record<string, string> | null;
  max_rows: number;
}

// Sentinel <option> value that opens the inline "name a new variable" input.
const NEW_VAR_SENTINEL = "__new_variable__";

interface ImportResult {
  inserted: number;
  linked: number;
  enrolled: number;
  already_enrolled: number;
  skipped_invalid_email: number;
  skipped_existing_elsewhere: number;
  skipped_dnc: number;
  skipped_suppressed: number;
  skipped_undeliverable: number;
  in_file_duplicates: number;
  total_received: number;
}

export function NativeImportPanel({ campaignId }: { campaignId: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const [filename, setFilename] = useState<string | null>(null);
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  // Which header is currently in "name a new variable" input mode, and its text.
  const [newVarHeader, setNewVarHeader] = useState<string | null>(null);
  const [newVarText, setNewVarText] = useState("");
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
  // Every custom variable the campaign already knows about (copy tokens +
  // list columns mapped on earlier imports), for the dropdown + re-matching a
  // re-uploaded column to an existing var before minting a new one.
  const knownCustomVars = useMemo(
    (): { token: string; key: string }[] => {
      const fromRegistry = (bootstrap?.variables ?? [])
        .filter((v) => v.kind === "custom")
        .map((v) => ({ token: v.token, key: v.key }));
      // Union with copy custom tokens, in case the registry hasn't been
      // persisted yet for this campaign; dedupe by normalized key.
      const byKey = new Map<string, { token: string; key: string }>();
      for (const v of [...fromRegistry, ...customTokens]) {
        if (v.key && !byKey.has(v.key)) byKey.set(v.key, { token: v.token, key: v.key });
      }
      return [...byKey.values()];
    },
    [bootstrap, customTokens],
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

  // Custom variables the copy uses with no CSV column mapped to them (advisory).
  // A token that carries an inline {{token|default}} everywhere can never blank,
  // so it's excluded. Match by normalized key so a re-spelled column still counts.
  const unmappedCustom = useMemo(() => {
    const mappedKeys = new Set(
      Object.values(columnMapping)
        .filter((t) => t.startsWith(CUSTOM_TARGET_PREFIX))
        .map((t) => normalizeVarKey(t.slice(CUSTOM_TARGET_PREFIX.length))),
    );
    return customTokens.filter((t) => !t.hasFallback && !mappedKeys.has(t.key));
  }, [customTokens, columnMapping]);

  // Standard tokens the templates use whose backing contact field has no mapped
  // column — those render BLANK at send time (buildTokenMap falls back to "" for
  // a missing standard field). Fully-defaulted tokens are excluded.
  const unmappedStandard = useMemo(() => {
    if (!bootstrap) return [];
    const mapped = new Set(Object.values(columnMapping));
    return bootstrap.tokens.standard.filter(
      (t) => !t.hasFallback && !t.fields.some((f) => mapped.has(f)),
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
    setNewVarHeader(null);
    setNewVarText("");
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
    setNewVarHeader(null);
    setColumnMapping(
      buildInitialMappingForTargets(
        headers,
        bootstrap?.saved_mapping ?? null,
        knownCustomVars,
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

  // "+ New variable…" flow: open an inline text input seeded with the column's
  // current custom name (or its header), commit to a custom: target on Enter/✓.
  function startNewVar(header: string) {
    const cur = columnMapping[header] ?? "";
    setNewVarText(
      cur.startsWith(CUSTOM_TARGET_PREFIX)
        ? cur.slice(CUSTOM_TARGET_PREFIX.length)
        : header,
    );
    setNewVarHeader(header);
  }
  function commitNewVar(header: string) {
    const name = newVarText.trim();
    if (!name) return; // empty → stay in input mode
    updateMapping(header, CUSTOM_TARGET_PREFIX + name);
    setNewVarHeader(null);
    setNewVarText("");
  }
  function cancelNewVar() {
    setNewVarHeader(null);
    setNewVarText("");
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
      // The server just persisted this mapping AND reconciled the registry; keep
      // the local bootstrap in sync so a second upload in the same session
      // pre-fills from it and shows freshly-created variables as "known" (not new).
      setBootstrap((b) => {
        if (!b) return b;
        const nextVars = [...b.variables];
        const seen = new Set(nextVars.map((v) => v.key));
        for (const target of Object.values(activeMapping)) {
          if (!target.startsWith(CUSTOM_TARGET_PREFIX)) continue;
          const tok = target.slice(CUSTOM_TARGET_PREFIX.length);
          const key = normalizeVarKey(tok);
          if (key && !seen.has(key)) {
            seen.add(key);
            nextVars.push({ token: tok, key, kind: "custom" });
          }
        }
        return { ...b, saved_mapping: activeMapping, variables: nextVars };
      });
      setFilename(null);
      setGrid(null);
      setColumnMapping({});
      setNewVarHeader(null);
      setNewVarText("");
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

  if (bootstrap.campaign.status !== "active" && bootstrap.campaign.status !== "draft") {
    return (
      <p className="text-sm text-muted-foreground py-2">
        Contacts can be added while this campaign is a draft or active.
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
                // Campaign-variable options for this column: every known var, plus
                // the current custom selection if it's a not-yet-registered one
                // (so a freshly-defaulted column still displays and can be re-picked).
                const valueCustomTok = value.startsWith(CUSTOM_TARGET_PREFIX)
                  ? value.slice(CUSTOM_TARGET_PREFIX.length)
                  : null;
                const varOptions = knownCustomVars.map((v) => ({ ...v, isNew: false }));
                if (
                  valueCustomTok &&
                  !varOptions.some((v) => v.key === normalizeVarKey(valueCustomTok))
                ) {
                  varOptions.push({
                    token: valueCustomTok,
                    key: normalizeVarKey(valueCustomTok),
                    isNew: true,
                  });
                }
                const inNewMode = newVarHeader === header;
                return (
                  <tr key={idx} className="border-t border-border/40">
                    <td className="px-3 py-2 font-medium">{header}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[200px]">
                      {sample || <span className="italic">empty</span>}
                    </td>
                    <td className="px-3 py-2">
                      {inNewMode ? (
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">{"{{"}</span>
                          <input
                            autoFocus
                            type="text"
                            value={newVarText}
                            onChange={(e) => setNewVarText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitNewVar(header);
                              } else if (e.key === "Escape") {
                                cancelNewVar();
                              }
                            }}
                            placeholder="variable name"
                            disabled={importing}
                            className="min-w-0 flex-1 rounded-md border border-[#2E37FE]/30 bg-[#2E37FE]/5 px-2 py-1 text-xs"
                          />
                          <span className="text-muted-foreground">{"}}"}</span>
                          <button
                            type="button"
                            onClick={() => commitNewVar(header)}
                            aria-label="Add variable"
                            className="text-emerald-600 hover:text-emerald-700"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={cancelNewVar}
                            aria-label="Cancel new variable"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <select
                          value={value}
                          onChange={(e) => {
                            if (e.target.value === NEW_VAR_SENTINEL) startNewVar(header);
                            else updateMapping(header, e.target.value);
                          }}
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
                          <optgroup label="Campaign variables">
                            {varOptions.map((t) => (
                              <option
                                key={t.key}
                                value={CUSTOM_TARGET_PREFIX + t.token}
                              >
                                {"{{"}
                                {t.token}
                                {"}}"}
                                {t.isNew ? "  (new)" : ""}
                              </option>
                            ))}
                            <option value={NEW_VAR_SENTINEL}>＋ New variable…</option>
                          </optgroup>
                        </select>
                      )}
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
                without a value (and no <code>{"{{token|default}}"}</code>) will
                be left blank.
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
                  {result.skipped_undeliverable > 0 && (
                    <>
                      {" "}
                      · {result.skipped_undeliverable} skipped (verified
                      undeliverable)
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
                    Sending starts automatically within a few minutes, during this
                    campaign&apos;s sending window, then paces across the day.
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
