// Shared CSV parsing helpers for contact imports.
//
// Originally inlined in src/app/(dashboard)/admin/contacts/import-dialog.tsx;
// extracted here so the campaign-detail import panel can reuse the same
// logic without duplication. The two callers share parser, header aliases,
// and row-to-payload normalization.

import type { ProspectStage } from "@/types/app";

// Minimal RFC4180-ish CSV parser. Handles quoted fields with commas and
// escaped quotes (""). Good enough for Apollo / LinkedIn / Sheets exports.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^﻿/, ""); // strip BOM
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

export const HEADER_ALIASES: Record<string, string> = {
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

export const VALID_STAGES: ProspectStage[] = [
  "lead",
  "contacted",
  "meeting",
  "proposal",
  "closed",
  "lost",
];

export function normalizeHeader(h: string): string {
  const key = h.trim().toLowerCase().replace(/_/g, " ");
  return HEADER_ALIASES[key] ?? key.replace(/\s+/g, "_");
}

// Tags cell may be ;-separated OR ,-separated (already unquoted by parseCSV).
export function splitTags(v: string): string[] {
  return v
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export type ParsedContactRow = {
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

export function rowsFromCSV(
  text: string,
): ParsedContactRow[] | { error: string } {
  const grid = parseCSV(text);
  if (grid.length < 2) {
    return { error: "CSV must have a header row and at least one data row." };
  }
  const headers = grid[0].map(normalizeHeader);
  const emailIdx = headers.indexOf("email");
  if (emailIdx < 0) {
    return { error: "CSV is missing a required 'email' column." };
  }

  const out: ParsedContactRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const get = (field: string) => {
      const i = headers.indexOf(field);
      return i >= 0 ? (row[i] ?? "").trim() : "";
    };
    const email = get("email");
    if (!email || !email.includes("@")) continue;
    const stageRaw = get("pipeline_stage").toLowerCase();
    const stage: ProspectStage | null = (VALID_STAGES as string[]).includes(
      stageRaw,
    )
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
