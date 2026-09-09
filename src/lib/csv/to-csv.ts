// Shared CSV builder + browser download helper. Exports across the app were each
// hand-rolling their own cell escaper (see the buyer contacts export route); this
// is the single place that logic should live so they can converge on it.

// UTF-8 byte-order mark. Prepended to downloads so Excel reads accented names
// (and other non-ASCII) correctly instead of garbling them.
const BOM = "﻿";

/** RFC-4180 cell escaping: wrap in quotes when the value contains a comma, quote,
 *  or newline, doubling any embedded quotes. */
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV string from a header row plus already-stringified data rows. Uses
 *  CRLF line endings, which Excel and Sheets both read cleanly. */
export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

/** Trigger a client-side download of `csv` as `filename`. Prepends a UTF-8 BOM so
 *  Excel reads accented names correctly. No-op when called outside the browser. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
