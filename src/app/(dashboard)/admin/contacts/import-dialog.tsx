"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import { normalizeDomain } from "@/lib/apify/domain";
// Shared CSV core (single parser + header-normalization rule + stage list), so
// this Path-B importer no longer keeps its own copy that can drift from the
// campaign importer. The alias TABLES below stay local — they're deliberately
// mode-split (a standard CSV keeps Website/Profile/Domain as custom variables).
import {
  parseCSV,
  splitTags,
  normalizeHeader,
  VALID_STAGES,
} from "@/lib/csv/parse-contacts";
import {
  Download,
  FileText,
  UploadCloud,
  X,
  AlertCircle,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import type { Contact, ContactStatus, ProspectStage } from "@/types/app";

type OwnerView = "leadstart" | "client";
type ImportMode = "standard" | "linkedin";

type ClientLite = { id: string; name: string };

const HEADER_ALIASES: Record<string, string> = {
  "first name": "first_name",
  first: "first_name",
  fname: "first_name",
  firstname: "first_name",
  "last name": "last_name",
  last: "last_name",
  lname: "last_name",
  lastname: "last_name",
  email: "email",
  "email address": "email",
  company: "company_name",
  "company name": "company_name",
  organization: "company_name",
  org: "company_name",
  title: "title",
  "job title": "title",
  role: "title",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  linkedin: "linkedin_url",
  "linkedin url": "linkedin_url",
  "linkedin profile": "linkedin_url",
  tags: "tags",
  notes: "notes",
  "intro line": "intro_line",
  intro: "intro_line",
  icebreaker: "intro_line",
  personalization: "intro_line",
  opener: "intro_line",
  "pipeline stage": "pipeline_stage",
  stage: "pipeline_stage",
};

// Extra aliases merged in ONLY for "LinkedIn list" mode. Kept separate so a
// standard CSV keeps treating "Website"/"Profile"/"Domain" as custom merge
// variables rather than special columns.
const LINKEDIN_HEADER_ALIASES: Record<string, string> = {
  "profile url": "linkedin_url",
  "linkedin profile url": "linkedin_url",
  linkedinurl: "linkedin_url",
  profile: "linkedin_url",
  "company linkedin url": "company_linkedin_url",
  "company linkedin": "company_linkedin_url",
  companylinkedinurl: "company_linkedin_url",
  "company url": "company_linkedin_url",
  "currentpositions/0/companylinkedinurl": "company_linkedin_url",
  domain: "company_domain",
  "company domain": "company_domain",
  website: "company_domain",
  "company website": "company_domain",
  // raw Apify profile-search export
  "currentpositions/0/companyname": "company_name",
  "currentpositions/0/title": "title",
  "location/linkedintext": "location", // → custom field
  // our cleaned export
  emailintext: "email",
  "email in text": "email",
};

// Normalized headers that land in a dedicated contact column. Anything else
// in the CSV is kept as a custom merge variable (contacts.custom_fields).
const STANDARD_FIELDS = new Set([
  "first_name",
  "last_name",
  "email",
  "company_name",
  "title",
  "phone",
  "linkedin_url",
  "company_linkedin_url",
  "company_domain",
  "tags",
  "intro_line",
  "notes",
  "pipeline_stage",
]);

function cleanDomainCell(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  return normalizeDomain(t) ?? null;
}

function normalizeLinkedinKey(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type ParsedRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  linkedin_url: string | null;
  company_linkedin_url: string | null;
  company_domain: string | null;
  tags: string[];
  intro_line: string | null;
  notes: string | null;
  pipeline_stage: ProspectStage | null;
  custom_fields: Record<string, string>;
};

type PreviewState = {
  filename: string;
  mode: ImportMode;
  rows: ParsedRow[];
  skipped: { index: number; reason: string }[];
};

function rowsFromCSV(
  text: string,
  mode: ImportMode,
): { rows: ParsedRow[]; skipped: { index: number; reason: string }[] } | { error: string } {
  const grid = parseCSV(text);
  if (grid.length < 2) return { error: "CSV must have a header row and at least one data row." };
  const rawHeaders = grid[0];
  const aliases = mode === "linkedin" ? { ...HEADER_ALIASES, ...LINKEDIN_HEADER_ALIASES } : HEADER_ALIASES;
  const headers = rawHeaders.map((h) => normalizeHeader(h, aliases));

  if (mode === "standard" && headers.indexOf("email") < 0) {
    return { error: "CSV is missing a required 'email' column." };
  }

  // Columns that aren't a standard field (and have a non-empty header) become
  // custom merge variables. In LinkedIn mode drop raw-export path columns
  // (currentPositions/1/…, skills/0, etc.) so custom_fields isn't bloated.
  const customIdxs = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => {
      if (STANDARD_FIELDS.has(h)) return false;
      if (!(rawHeaders[i] ?? "").trim()) return false;
      if (mode === "linkedin" && h.includes("/")) return false;
      return true;
    })
    .map(({ h, i }) => ({ h, i }));

  const rows: ParsedRow[] = [];
  const skipped: { index: number; reason: string }[] = [];

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const get = (field: string) => {
      const i = headers.indexOf(field);
      return i >= 0 ? (row[i] ?? "").trim() : "";
    };
    const emailRaw = get("email");
    const email = emailRaw.includes("@") ? emailRaw : null;
    const linkedin = get("linkedin_url") || null;
    const firstName = get("first_name") || null;
    const lastName = get("last_name") || null;
    const company = get("company_name") || null;

    if (mode === "standard") {
      if (!email) continue; // standard mode requires an email (unchanged)
    } else {
      const identifiable = Boolean(linkedin) || Boolean(firstName && lastName && company);
      if (!identifiable) {
        skipped.push({ index: r, reason: "no LinkedIn URL or name + company" });
        continue;
      }
    }

    const stageRaw = get("pipeline_stage").toLowerCase();
    const stage: ProspectStage | null = (VALID_STAGES as string[]).includes(stageRaw)
      ? (stageRaw as ProspectStage)
      : null;

    const custom_fields: Record<string, string> = {};
    for (const { h, i } of customIdxs) {
      const val = (row[i] ?? "").trim();
      if (!val) continue;
      // Use the normalized header when an alias fired (e.g. location), else the
      // original header spelling.
      const wasAliased = h !== normalizeHeader(rawHeaders[i], HEADER_ALIASES);
      custom_fields[wasAliased ? h : rawHeaders[i].trim()] = val;
    }

    rows.push({
      first_name: firstName,
      last_name: lastName,
      email,
      company_name: company,
      title: get("title") || null,
      phone: get("phone") || null,
      linkedin_url: linkedin,
      company_linkedin_url: get("company_linkedin_url") || null,
      company_domain: cleanDomainCell(get("company_domain")),
      tags: splitTags(get("tags")),
      intro_line: get("intro_line") || null,
      notes: get("notes") || null,
      pipeline_stage: stage,
      custom_fields,
    });
  }
  return { rows, skipped };
}

export function ImportContactsDialog({
  open,
  onOpenChange,
  ownerView,
  organizationId,
  clients,
  existingContactCount,
  onImported,
  onEnrichStarted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ownerView: OwnerView;
  organizationId: string | null;
  clients: ClientLite[];
  existingContactCount: (stage: ProspectStage) => number;
  onImported: () => void | Promise<void>;
  onEnrichStarted?: (runId: string) => void;
}) {
  const [importMode, setImportMode] = useState<ImportMode>("standard");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [targetClientId, setTargetClientId] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    inserted: number;
    skipped_duplicates: number;
    insertedIds: string[];
  } | null>(null);
  const [enrichStarting, setEnrichStarting] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // next.config.ts sets basePath "/app", so public assets live at /app/<file>.
  const sampleHref = useMemo(
    () =>
      ownerView === "leadstart"
        ? "/app/sample-contacts-leadstart.csv"
        : "/app/sample-contacts-client.csv",
    [ownerView],
  );

  function reset() {
    setPreview(null);
    setParseError(null);
    setResult(null);
    setTargetClientId("");
    setEnrichError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function switchMode(mode: ImportMode) {
    setImportMode(mode);
    reset();
  }

  async function handleFile(file: File) {
    setParseError(null);
    setResult(null);
    const text = await file.text();
    const parsed = rowsFromCSV(text, importMode);
    if ("error" in parsed) {
      setPreview(null);
      setParseError(parsed.error);
      return;
    }
    if (parsed.rows.length === 0) {
      setPreview(null);
      setParseError(
        importMode === "linkedin"
          ? "No valid rows found (every row needs a LinkedIn URL, or first name + last name + company)."
          : "No valid rows found (every row needs a non-empty email).",
      );
      return;
    }
    setPreview({ filename: file.name, mode: importMode, rows: parsed.rows, skipped: parsed.skipped });
  }

  async function handleImport() {
    if (!preview) return;
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    if (ownerView === "client" && !targetClientId) {
      alert("Pick which client these contacts belong to.");
      return;
    }
    setImporting(true);
    try {
      const supabase = createClient();
      const now = new Date().toISOString();
      const linkedinMode = preview.mode === "linkedin";

      // ---- dedupe: in-file (email + linkedin), then against the DB ----
      const seenEmail = new Set<string>();
      const seenLinkedin = new Set<string>();
      let inFileDupes = 0;
      const deduped: ParsedRow[] = [];
      for (const r of preview.rows) {
        const ek = r.email?.toLowerCase() ?? null;
        const lk = r.linkedin_url ? normalizeLinkedinKey(r.linkedin_url) : null;
        if (ek && seenEmail.has(ek)) { inFileDupes++; continue; }
        if (lk && seenLinkedin.has(lk)) { inFileDupes++; continue; }
        if (ek) seenEmail.add(ek);
        if (lk) seenLinkedin.add(lk);
        deduped.push(r);
      }

      // DB email dedupe (both modes).
      const emails = deduped.map((r) => r.email?.toLowerCase()).filter((e): e is string => Boolean(e));
      const existingEmails = new Set<string>();
      for (const part of chunk(emails, 200)) {
        const { data, error } = await supabase
          .from("contacts")
          .select("email")
          .eq("organization_id", organizationId)
          .in("email", part);
        if (error) {
          alert(`Failed to check for duplicates: ${error.message}`);
          return;
        }
        for (const c of (data as { email: string | null }[] | null) ?? []) {
          if (c.email) existingEmails.add(c.email.toLowerCase());
        }
      }

      // DB linkedin dedupe (LinkedIn mode only). Exact-match .in() on both the
      // raw and a lowercased variant — good enough for re-imports of the same
      // export (the real duplicate case).
      const existingLinkedin = new Set<string>();
      if (linkedinMode) {
        const urls = deduped.map((r) => r.linkedin_url).filter((u): u is string => Boolean(u));
        const variants = Array.from(new Set(urls.flatMap((u) => [u, u.toLowerCase()])));
        for (const part of chunk(variants, 200)) {
          const { data, error } = await supabase
            .from("contacts")
            .select("linkedin_url")
            .eq("organization_id", organizationId)
            .in("linkedin_url", part);
          if (error) {
            alert(`Failed to check for duplicates: ${error.message}`);
            return;
          }
          for (const c of (data as { linkedin_url: string | null }[] | null) ?? []) {
            if (c.linkedin_url) existingLinkedin.add(normalizeLinkedinKey(c.linkedin_url));
          }
        }
      }

      const toInsert = deduped.filter((r) => {
        const ek = r.email?.toLowerCase() ?? null;
        const lk = r.linkedin_url ? normalizeLinkedinKey(r.linkedin_url) : null;
        if (ek && existingEmails.has(ek)) return false;
        if (lk && existingLinkedin.has(lk)) return false;
        return true;
      });
      let crossDbDupes = deduped.length - toInsert.length;

      // ---- build payload ----
      const stageOffsets: Record<ProspectStage, number> = {
        lead: existingContactCount("lead"),
        contacted: existingContactCount("contacted"),
        meeting: existingContactCount("meeting"),
        proposal: existingContactCount("proposal"),
        closed: existingContactCount("closed"),
        lost: existingContactCount("lost"),
      };

      const payload = toInsert.map((r) => {
        const stage = ownerView === "client" ? null : r.pipeline_stage;
        const sortOrder = stage ? stageOffsets[stage]++ : 0;
        return {
          id: crypto.randomUUID(),
          organization_id: organizationId,
          client_id: ownerView === "client" ? targetClientId : null,
          campaign_id: null,
          first_name: r.first_name,
          last_name: r.last_name,
          email: r.email ?? null,
          company_name: r.company_name,
          title: r.title,
          phone: r.phone,
          linkedin_url: r.linkedin_url,
          company_linkedin_url: r.company_linkedin_url,
          company_domain: r.company_domain,
          intro_line: ownerView === "client" ? r.intro_line : null,
          enrichment_data: {},
          custom_fields: r.custom_fields,
          tags: linkedinMode ? Array.from(new Set([...r.tags, "linkedin"])) : r.tags,
          status: "new" as ContactStatus,
          source: linkedinMode ? "linkedin-import" : "csv-import",
          notes: r.notes,
          pipeline_stage: stage,
          pipeline_sort_order: sortOrder,
          pipeline_notes: null,
          pipeline_follow_up_date: null,
          pipeline_added_at: stage ? now : null,
          created_at: now,
          updated_at: now,
        } satisfies Partial<Contact> & { id: string };
      });

      // ---- chunked insert with a 23505 (unique email) per-row fallback ----
      const insertedIds: string[] = [];
      for (const part of chunk(payload, 200)) {
        const { error } = await supabase.from("contacts").insert(part);
        if (!error) {
          insertedIds.push(...part.map((p) => p.id));
          continue;
        }
        if ((error as { code?: string }).code === "23505") {
          // A case-variant email already exists — retry the chunk row-by-row.
          for (const one of part) {
            const { error: oneErr } = await supabase.from("contacts").insert(one);
            if (!oneErr) insertedIds.push(one.id);
            else if ((oneErr as { code?: string }).code === "23505") crossDbDupes++;
            else {
              alert(`Failed to import: ${oneErr.message}`);
              return;
            }
          }
          continue;
        }
        alert(`Failed to import: ${error.message}`);
        return;
      }

      setResult({
        inserted: insertedIds.length,
        skipped_duplicates: inFileDupes + crossDbDupes,
        insertedIds,
      });
      await onImported();
    } finally {
      setImporting(false);
    }
  }

  async function handleEnrichNow() {
    if (!result || result.insertedIds.length === 0) return;
    setEnrichStarting(true);
    setEnrichError(null);
    try {
      const res = await fetch(appUrl("/api/admin/contacts/enrich/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_ids: result.insertedIds,
          run_profiles: true,
          run_domains: true,
          run_waterfall: true,
          run_activity: true,
        }),
      });
      const data = (await res.json()) as { run_id?: string; error?: string };
      if (!res.ok || !data.run_id) {
        setEnrichError(data.error ?? `Failed to start enrichment (${res.status})`);
        return;
      }
      onEnrichStarted?.(data.run_id);
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnrichStarting(false);
    }
  }

  const linkedinMode = importMode === "linkedin";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-3 border-b border-border/50 shrink-0">
          <DialogTitle>
            Import {ownerView === "leadstart" ? "LeadStart" : "Client"} Contacts from CSV
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto px-6 pt-4 pb-6 flex-1 min-h-0 space-y-4">
          {/* Mode toggle */}
          {!preview && !result && (
            <div className="space-y-1.5">
              <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => switchMode("standard")}
                  className={`px-3 py-1.5 rounded-md transition-colors ${importMode === "standard" ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}
                >
                  Standard CSV
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("linkedin")}
                  className={`px-3 py-1.5 rounded-md transition-colors ${importMode === "linkedin" ? "bg-background shadow-sm font-medium" : "text-muted-foreground"}`}
                >
                  LinkedIn list (no emails)
                </button>
              </div>
              {linkedinMode && (
                <p className="text-xs text-muted-foreground">
                  For Apify / Sales Navigator exports. Rows need a LinkedIn URL, or first name + last
                  name + company. Emails are optional — run enrichment afterward.
                </p>
              )}
            </div>
          )}

          {/* Sample download (standard mode only) */}
          {!linkedinMode && (
            <div className="rounded-xl border border-border/50 bg-muted/30 p-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <FileText size={18} className="text-[#2E37FE] shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Not sure about the format?</p>
                  <p className="text-xs text-muted-foreground">
                    Grab our sample {ownerView === "leadstart" ? "LeadStart" : "Client"} template.
                  </p>
                </div>
              </div>
              <a href={sampleHref} download>
                <Button size="sm" variant="outline" className="shrink-0">
                  <Download size={14} className="mr-1" />
                  Download sample
                </Button>
              </a>
            </div>
          )}

          {/* File picker */}
          {!preview && (
            <label className="block cursor-pointer rounded-xl border-2 border-dashed border-border p-6 text-center hover:border-[#2E37FE]/50 hover:bg-[#EDEEFF]/30 transition-colors">
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <UploadCloud size={28} className="mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-medium">Click to choose a CSV file</p>
              {linkedinMode ? (
                <p className="text-xs text-muted-foreground mt-1">
                  Recognized: firstName, lastName, title, company, domain, linkedinUrl,
                  companyLinkedinUrl (raw Apify headers like{" "}
                  <code className="font-mono">currentPositions/0/companyName</code> work too).
                  location, seniority, region are kept as custom variables.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  Required column: <code className="font-mono">email</code>. Optional: first_name,
                  last_name, company_name, title, phone, linkedin_url, tags (; or , separated), notes
                  {ownerView === "leadstart" ? ", pipeline_stage" : ", intro_line"}. Any other
                  columns are saved as custom variables (e.g.{" "}
                  <code className="font-mono">{`{{Property Address}}`}</code>).
                </p>
              )}
            </label>
          )}

          {parseError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex items-start gap-2 text-sm">
              <AlertCircle size={16} className="text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-destructive">Couldn&apos;t parse the file</p>
                <p className="text-muted-foreground mt-0.5">{parseError}</p>
              </div>
            </div>
          )}

          {preview && !result && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText size={16} className="text-[#2E37FE] shrink-0" />
                  <p className="text-sm font-medium truncate">{preview.filename}</p>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={reset}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 cursor-pointer"
                >
                  <X size={12} />
                  Replace file
                </button>
              </div>

              {ownerView === "client" && (
                <div className="space-y-1">
                  <Label className="text-sm font-medium">Assign all to client *</Label>
                  <Select value={targetClientId} onValueChange={(v) => setTargetClientId(v ?? "")}>
                    <SelectTrigger className="w-full" style={{ height: "36px" }}>
                      <SelectValue placeholder="Select a client">
                        {targetClientId
                          ? clients.find((c) => c.id === targetClientId)?.name ?? "Select a client"
                          : "Select a client"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="min-w-[220px]" alignItemWithTrigger={false}>
                      {clients.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">No clients yet.</div>
                      ) : (
                        clients.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="rounded-lg border border-border/50 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Name</th>
                        {linkedinMode ? (
                          <>
                            <th className="px-3 py-2 text-left font-medium">Company</th>
                            <th className="px-3 py-2 text-left font-medium">LinkedIn</th>
                            <th className="px-3 py-2 text-left font-medium">Company URL / Domain</th>
                          </>
                        ) : (
                          <>
                            <th className="px-3 py-2 text-left font-medium">Email</th>
                            <th className="px-3 py-2 text-left font-medium">Company</th>
                            {ownerView === "leadstart" && (
                              <th className="px-3 py-2 text-left font-medium">Stage</th>
                            )}
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 6).map((r, i) => (
                        <tr key={i} className="border-t border-border/40">
                          <td className="px-3 py-1.5">
                            {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                          </td>
                          {linkedinMode ? (
                            <>
                              <td className="px-3 py-1.5 text-muted-foreground">{r.company_name || "—"}</td>
                              <td className="px-3 py-1.5 text-muted-foreground max-w-[180px] truncate">
                                {r.linkedin_url || "—"}
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground max-w-[180px] truncate">
                                {r.company_domain || r.company_linkedin_url || "—"}
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="px-3 py-1.5 text-muted-foreground">{r.email ?? "—"}</td>
                              <td className="px-3 py-1.5 text-muted-foreground">{r.company_name || "—"}</td>
                              {ownerView === "leadstart" && (
                                <td className="px-3 py-1.5 text-muted-foreground">{r.pipeline_stage || "—"}</td>
                              )}
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.rows.length > 6 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground border-t border-border/40">
                    + {preview.rows.length - 6} more row{preview.rows.length - 6 === 1 ? "" : "s"} not shown.
                  </p>
                )}
                {preview.skipped.length > 0 && (
                  <p className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-t border-border/40">
                    {preview.skipped.length} row{preview.skipped.length === 1 ? "" : "s"} skipped (no LinkedIn URL or name + company).
                  </p>
                )}
              </div>
            </>
          )}

          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 flex items-start gap-2 text-sm">
              <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-2">
                <div>
                  <p className="font-medium text-emerald-800">
                    Imported {result.inserted} contact{result.inserted === 1 ? "" : "s"}.
                    {result.skipped_duplicates > 0 && (
                      <span className="font-normal text-emerald-700/80">
                        {" "}
                        {result.skipped_duplicates} duplicate{result.skipped_duplicates === 1 ? "" : "s"} skipped.
                      </span>
                    )}
                  </p>
                  {!linkedinMode && (
                    <p className="text-muted-foreground mt-0.5">
                      They&apos;re in the {ownerView === "leadstart" ? "LeadStart" : "Client"} contacts list now.
                    </p>
                  )}
                </div>
                {linkedinMode && result.insertedIds.length > 0 && (
                  <div className="space-y-1.5">
                    <Button
                      size="sm"
                      style={{ background: "#2E37FE" }}
                      disabled={enrichStarting}
                      onClick={handleEnrichNow}
                    >
                      <Sparkles size={14} className="mr-1" />
                      {enrichStarting ? "Starting…" : `Enrich these ${result.inserted} now`}
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Resolves company domains, finds &amp; verifies emails via Apify.
                    </p>
                    {enrichError && (
                      <p className="text-[11px] text-red-600">
                        {enrichError}{" "}
                        <Link href="/admin/settings/api" className="underline">
                          Open Integrations settings
                        </Link>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 px-6 py-4 border-t border-border/50 shrink-0">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              className="flex-1"
              style={{ background: "#2E37FE" }}
              disabled={!preview || importing || (ownerView === "client" && !targetClientId)}
              onClick={handleImport}
            >
              {importing
                ? "Importing..."
                : preview
                  ? `Import ${preview.rows.length} contact${preview.rows.length === 1 ? "" : "s"}`
                  : "Import"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
