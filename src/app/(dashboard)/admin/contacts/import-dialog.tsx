"use client";

import { useMemo, useRef, useState } from "react";
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
import {
  Download,
  FileText,
  UploadCloud,
  X,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import type { Contact, ContactStatus, ProspectStage } from "@/types/app";

type OwnerView = "leadstart" | "client";

type ClientLite = { id: string; name: string };

// Minimal RFC4180-ish CSV parser. Handles quoted fields with commas and
// escaped quotes (""). Good enough for Apollo / LinkedIn / Sheets exports.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^\uFEFF/, ""); // strip BOM
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      if (c === "\r" && s[i + 1] === "\n") i += 2;
      else i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

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

const VALID_STAGES: ProspectStage[] = [
  "lead",
  "contacted",
  "meeting",
  "proposal",
  "closed",
  "lost",
];

function normalizeHeader(h: string): string {
  const key = h.trim().toLowerCase().replace(/_/g, " ");
  return HEADER_ALIASES[key] ?? key.replace(/\s+/g, "_");
}

// Tags cell may be ;-separated OR ,-separated (already unquoted by parseCSV).
function splitTags(v: string): string[] {
  return v
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

type ParsedRow = {
  first_name: string | null;
  last_name: string | null;
  email: string;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  linkedin_url: string | null;
  tags: string[];
  intro_line: string | null;
  notes: string | null;
  pipeline_stage: ProspectStage | null;
};

type PreviewState = {
  filename: string;
  rows: ParsedRow[];
  skipped: { index: number; reason: string }[];
};

function rowsFromCSV(text: string): PreviewState["rows"] | { error: string } {
  const grid = parseCSV(text);
  if (grid.length < 2) return { error: "CSV must have a header row and at least one data row." };
  const headers = grid[0].map(normalizeHeader);
  const emailIdx = headers.indexOf("email");
  if (emailIdx < 0) return { error: "CSV is missing a required 'email' column." };

  const out: ParsedRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const get = (field: string) => {
      const i = headers.indexOf(field);
      return i >= 0 ? (row[i] ?? "").trim() : "";
    };
    const email = get("email");
    if (!email || !email.includes("@")) continue;
    const stageRaw = get("pipeline_stage").toLowerCase();
    const stage: ProspectStage | null = (VALID_STAGES as string[]).includes(stageRaw)
      ? (stageRaw as ProspectStage)
      : null;
    out.push({
      first_name: get("first_name") || null,
      last_name: get("last_name") || null,
      email,
      company_name: get("company_name") || null,
      title: get("title") || null,
      phone: get("phone") || null,
      linkedin_url: get("linkedin_url") || null,
      tags: splitTags(get("tags")),
      intro_line: get("intro_line") || null,
      notes: get("notes") || null,
      pipeline_stage: stage,
    });
  }
  return out;
}

export function ImportContactsDialog({
  open,
  onOpenChange,
  ownerView,
  organizationId,
  clients,
  existingContactCount,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ownerView: OwnerView;
  organizationId: string | null;
  clients: ClientLite[];
  existingContactCount: (stage: ProspectStage) => number;
  onImported: () => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [targetClientId, setTargetClientId] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    inserted: number;
    skipped: number;
  } | null>(null);
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
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFile(file: File) {
    setParseError(null);
    setResult(null);
    const text = await file.text();
    const rows = rowsFromCSV(text);
    if ("error" in rows) {
      setPreview(null);
      setParseError(rows.error);
      return;
    }
    if (rows.length === 0) {
      setPreview(null);
      setParseError("No valid rows found (every row needs a non-empty email).");
      return;
    }
    setPreview({ filename: file.name, rows, skipped: [] });
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

      // Track per-stage sort order locally so multiple new leads within one
      // import get sequential positions (not all zero).
      const stageOffsets: Record<ProspectStage, number> = {
        lead: existingContactCount("lead"),
        contacted: existingContactCount("contacted"),
        meeting: existingContactCount("meeting"),
        proposal: existingContactCount("proposal"),
        closed: existingContactCount("closed"),
        lost: existingContactCount("lost"),
      };

      const payload = preview.rows.map((r) => {
        const stage =
          ownerView === "client" ? null : r.pipeline_stage;
        const sortOrder = stage ? stageOffsets[stage]++ : 0;
        return {
          id: crypto.randomUUID(),
          organization_id: organizationId,
          client_id: ownerView === "client" ? targetClientId : null,
          campaign_id: null,
          first_name: r.first_name,
          last_name: r.last_name,
          email: r.email,
          company_name: r.company_name,
          title: r.title,
          phone: r.phone,
          linkedin_url: r.linkedin_url,
          // intro_line is a Client-only field today; LeadStart doesn't use
          // it yet, so drop anything in that column on LeadStart imports.
          intro_line: ownerView === "client" ? r.intro_line : null,
          enrichment_data: {},
          tags: r.tags,
          status: "new" as ContactStatus,
          source: "csv-import",
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

      const { error } = await supabase.from("contacts").insert(payload);
      if (error) {
        alert(`Failed to import: ${error.message}`);
        return;
      }
      setResult({ inserted: payload.length, skipped: 0 });
      await onImported();
    } finally {
      setImporting(false);
    }
  }

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
            Import {ownerView === "leadstart" ? "LeadStart" : "Client"}{" "}
            Contacts from CSV
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto px-6 pt-4 pb-6 flex-1 min-h-0 space-y-4">
          {/* Sample download */}
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
              <UploadCloud
                size={28}
                className="mx-auto text-muted-foreground mb-2"
              />
              <p className="text-sm font-medium">Click to choose a CSV file</p>
              <p className="text-xs text-muted-foreground mt-1">
                Required column: <code className="font-mono">email</code>.
                Optional: first_name, last_name, company_name, title, phone,
                linkedin_url, tags (; or , separated), notes
                {ownerView === "leadstart"
                  ? ", pipeline_stage"
                  : ", intro_line"}
                .
              </p>
            </label>
          )}

          {parseError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex items-start gap-2 text-sm">
              <AlertCircle size={16} className="text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-destructive">
                  Couldn&apos;t parse the file
                </p>
                <p className="text-muted-foreground mt-0.5">{parseError}</p>
              </div>
            </div>
          )}

          {preview && !result && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText size={16} className="text-[#2E37FE] shrink-0" />
                  <p className="text-sm font-medium truncate">
                    {preview.filename}
                  </p>
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
                  <Label className="text-sm font-medium">
                    Assign all to client *
                  </Label>
                  <Select
                    value={targetClientId}
                    onValueChange={(v) => setTargetClientId(v ?? "")}
                  >
                    <SelectTrigger className="w-full" style={{ height: "36px" }}>
                      <SelectValue placeholder="Select a client">
                        {targetClientId
                          ? clients.find((c) => c.id === targetClientId)?.name ??
                            "Select a client"
                          : "Select a client"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      className="min-w-[220px]"
                      alignItemWithTrigger={false}
                    >
                      {clients.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-muted-foreground">
                          No clients yet.
                        </div>
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
                        <th className="px-3 py-2 text-left font-medium">Email</th>
                        <th className="px-3 py-2 text-left font-medium">Company</th>
                        {ownerView === "leadstart" && (
                          <th className="px-3 py-2 text-left font-medium">Stage</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 6).map((r, i) => (
                        <tr key={i} className="border-t border-border/40">
                          <td className="px-3 py-1.5">
                            {[r.first_name, r.last_name].filter(Boolean).join(" ") ||
                              "—"}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {r.email}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {r.company_name || "—"}
                          </td>
                          {ownerView === "leadstart" && (
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {r.pipeline_stage || "—"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.rows.length > 6 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground border-t border-border/40">
                    + {preview.rows.length - 6} more row
                    {preview.rows.length - 6 === 1 ? "" : "s"} not shown.
                  </p>
                )}
              </div>
            </>
          )}

          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 flex items-start gap-2 text-sm">
              <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium text-emerald-800">
                  Imported {result.inserted} contact
                  {result.inserted === 1 ? "" : "s"}.
                </p>
                <p className="text-muted-foreground mt-0.5">
                  They&apos;re in the{" "}
                  {ownerView === "leadstart" ? "LeadStart" : "Client"} contacts
                  list now.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 px-6 py-4 border-t border-border/50 shrink-0">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              className="flex-1"
              style={{ background: "#2E37FE" }}
              disabled={
                !preview ||
                importing ||
                (ownerView === "client" && !targetClientId)
              }
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
