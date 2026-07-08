"use client";

// /admin/salesforge/dnc — bulk-add emails to the Salesforge do-not-
// contact list. Paste a list of emails (one per line, comma- or
// space-separated), validate locally, then push to Salesforge.

import { useState, useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ShieldOff, Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

function parseEmails(input: string): string[] {
  // Split on whitespace, commas, semicolons, newlines.
  const candidates = input
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  // Dedup + filter to anything containing @ (very permissive — let
  // Salesforge do the strict validation server-side).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c.includes("@") || c.length < 5) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export default function DNCManagerPage() {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    { kind: "success"; added: number } | { kind: "fail"; message: string } | null
  >(null);

  const parsed = useMemo(() => parseEmails(input), [input]);

  async function submit() {
    setResult(null);
    if (parsed.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(appUrl("/api/admin/salesforge/dnc"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dncs: parsed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `DNC add failed (${res.status})`);
      setResult({ kind: "success", added: data.added ?? parsed.length });
      setInput("");
    } catch (err) {
      setResult({ kind: "fail", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="relative overflow-hidden rounded-[12px] p-5 sm:p-7" style={{ background: "#EDEEFF", border: "1px solid #e2e8f0" }}>
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">Do-not-contact list</h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          Add email addresses to the workspace-wide DNC list. Salesforge
          stops contacting these addresses across all sequences and
          dedupes server-side.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldOff size={16} /> Bulk add
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Paste emails (one per line, or comma/space separated). Up to
            1,000 per submission.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={10}
            placeholder={"alice@example.com\nbob@example.com\ncharlie@example.com"}
            disabled={submitting}
            className="font-mono text-sm"
          />
          <div className="flex items-center gap-2">
            <Badge variant="secondary">
              {parsed.length} valid email{parsed.length === 1 ? "" : "s"} parsed
            </Badge>
            {parsed.length > 1000 && (
              <Badge className="bg-red-100 text-red-700">Over 1,000 — submit in batches</Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={submit}
              disabled={submitting || parsed.length === 0 || parsed.length > 1000}
              style={{ background: "#2E37FE" }}
            >
              {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <ShieldOff size={14} className="mr-1" />}
              Add {parsed.length} to DNC
            </Button>
            {result?.kind === "success" && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle size={14} /> Added {result.added}
              </span>
            )}
            {result?.kind === "fail" && (
              <span className="text-sm text-red-600 flex items-center gap-1">
                <AlertCircle size={14} /> {result.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
