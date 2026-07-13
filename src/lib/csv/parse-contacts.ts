// Shared CSV parsing helpers for contact imports.
//
// Originally inlined in src/app/(dashboard)/admin/contacts/import-dialog.tsx;
// extracted here so the campaign-detail import panel can reuse the same
// logic without duplication. The two callers share parser, header aliases,
// and row-to-payload normalization.

import type { ProspectStage } from "@/types/app";
import { normalizeVarKey } from "@/lib/native/tokens";

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

// Apply a user-provided column mapping to a parsed CSV grid.
// mapping: { "CSV Header Name": "first_name", ... } — empty string = skip.
export function rowsWithMapping(
  grid: string[][],
  mapping: Record<string, string>,
): ParsedContactRow[] {
  if (grid.length < 2) return [];

  const rawHeaders = grid[0].map((h) => h.trim());
  const fieldToCol: Record<string, number> = {};
  for (let i = 0; i < rawHeaders.length; i++) {
    const target = mapping[rawHeaders[i]];
    if (target) fieldToCol[target] = i;
  }

  if (fieldToCol.email === undefined) return [];

  const out: ParsedContactRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const get = (field: string) => {
      const i = fieldToCol[field];
      return i !== undefined ? (row[i] ?? "").trim() : "";
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

// Mapping targets prefixed with this map into contacts.custom_fields instead
// of a standard column: "custom:PropertyAddress" stores the cell under the
// JSONB key "PropertyAddress". The native renderer matches custom_fields keys
// normalizeVarKey-insensitively, so the spelling only affects inspection.
export const CUSTOM_TARGET_PREFIX = "custom:";

export type ParsedContactRowWithCustom = ParsedContactRow & {
  custom_fields: Record<string, string>;
};

// Like rowsWithMapping, but also honors "custom:<Key>" targets, landing them
// in custom_fields (empty cells omitted). Kept separate so the existing
// rowsWithMapping contract stays untouched.
export function rowsWithMappingAndCustom(
  grid: string[][],
  mapping: Record<string, string>,
): ParsedContactRowWithCustom[] {
  if (grid.length < 2) return [];

  const rawHeaders = grid[0].map((h) => h.trim());
  const fieldToCol: Record<string, number> = {};
  const customCols: { col: number; key: string }[] = [];
  for (let i = 0; i < rawHeaders.length; i++) {
    const target = mapping[rawHeaders[i]];
    if (!target) continue;
    if (target.startsWith(CUSTOM_TARGET_PREFIX)) {
      const key = target.slice(CUSTOM_TARGET_PREFIX.length).trim();
      if (key) customCols.push({ col: i, key });
    } else {
      fieldToCol[target] = i;
    }
  }

  if (fieldToCol.email === undefined) return [];

  const out: ParsedContactRowWithCustom[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const get = (field: string) => {
      const i = fieldToCol[field];
      return i !== undefined ? (row[i] ?? "").trim() : "";
    };
    const email = get("email");
    if (!email || !email.includes("@")) continue;
    const stageRaw = get("pipeline_stage").toLowerCase();
    const stage: ProspectStage | null = (VALID_STAGES as string[]).includes(
      stageRaw,
    )
      ? (stageRaw as ProspectStage)
      : null;
    const custom_fields: Record<string, string> = {};
    for (const { col, key } of customCols) {
      const v = (row[col] ?? "").trim();
      if (v) custom_fields[key] = v;
    }
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
      custom_fields,
    });
  }
  return out;
}

// LeadStart contact fields available as mapping targets.
export const MAPPING_TARGETS: { value: string; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "first_name", label: "First Name" },
  { value: "last_name", label: "Last Name" },
  { value: "company_name", label: "Company" },
  { value: "title", label: "Job Title" },
  { value: "phone", label: "Phone" },
  { value: "linkedin_url", label: "LinkedIn URL" },
  { value: "intro_line", label: "Intro / Icebreaker" },
  { value: "notes", label: "Notes" },
  { value: "tags", label: "Tags" },
];

const VALID_TARGET_SET = new Set(MAPPING_TARGETS.map((f) => f.value));

// Like buildInitialMapping, but target-aware for a campaign's own merge
// variables: priority is saved mapping (custom: entries re-matched by
// normalized key so a re-spelled template token still hits) → HEADER_ALIASES
// auto-detect → header folding to a campaign token key → unmapped. One CSV
// column per target, same as buildInitialMapping.
export function buildInitialMappingForTargets(
  csvHeaders: string[],
  savedMapping: Record<string, string> | null,
  customTokens: { token: string; key: string }[],
): Record<string, string> {
  const customByKey = new Map(customTokens.map((t) => [t.key, t]));
  const mapping: Record<string, string> = {};
  const used = new Set<string>();

  const claim = (header: string, target: string): boolean => {
    if (used.has(target)) return false;
    mapping[header] = target;
    used.add(target);
    return true;
  };

  for (const header of csvHeaders) {
    // Object.hasOwn + string guard: savedMapping is JSON from the DB, so a
    // header named "constructor" must not resolve to a prototype member, and
    // a non-string value must not reach .startsWith().
    if (savedMapping && Object.hasOwn(savedMapping, header)) {
      const saved = savedMapping[header];
      if (typeof saved === "string" && saved.startsWith(CUSTOM_TARGET_PREFIX)) {
        const key = normalizeVarKey(saved.slice(CUSTOM_TARGET_PREFIX.length));
        const tok = customByKey.get(key);
        if (tok && claim(header, CUSTOM_TARGET_PREFIX + tok.token)) continue;
      } else if (VALID_TARGET_SET.has(saved) && claim(header, saved)) {
        continue;
      }
    }
    const normalized = normalizeHeader(header);
    if (VALID_TARGET_SET.has(normalized) && claim(header, normalized)) continue;
    const tok = customByKey.get(normalizeVarKey(header));
    if (tok && claim(header, CUSTOM_TARGET_PREFIX + tok.token)) continue;
    mapping[header] = "";
  }

  return mapping;
}

// Build initial column mapping from CSV headers, using a saved mapping
// first, then falling back to HEADER_ALIASES auto-detection.
export function buildInitialMapping(
  csvHeaders: string[],
  savedMapping: Record<string, string> | null,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const usedTargets = new Set<string>();

  for (const header of csvHeaders) {
    if (savedMapping && header in savedMapping) {
      const target = savedMapping[header];
      if (VALID_TARGET_SET.has(target) && !usedTargets.has(target)) {
        mapping[header] = target;
        usedTargets.add(target);
        continue;
      }
    }
    const normalized = normalizeHeader(header);
    if (VALID_TARGET_SET.has(normalized) && !usedTargets.has(normalized)) {
      mapping[header] = normalized;
      usedTargets.add(normalized);
      continue;
    }
    mapping[header] = "";
  }

  return mapping;
}
