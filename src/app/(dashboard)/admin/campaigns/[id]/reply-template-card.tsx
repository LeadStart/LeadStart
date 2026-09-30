"use client";

// The campaign's saved reply for hot leads (campaigns.reply_template, migration
// 00134). When a lead from this campaign replies, the admin inbox's reply box
// starts with this text, {{tokens}} filled for that lead: {{report_link}} is the
// prospect's own TuBe report link. The owner writes the words; nothing is
// generated, and the reply is read before it's sent.

import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquareReply, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

export function ReplyTemplateCard({
  campaignId,
  initial,
  tokens,
}: {
  campaignId: string;
  initial: string | null;
  /** Token names this campaign's contacts carry (first_name, report_link…). */
  tokens: string[];
}) {
  const [text, setText] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const dirty = text.trim() !== saved.trim();

  function insert(token: string) {
    const el = area.current;
    const tag = `{{${token}}}`;
    const at = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    const next = text.slice(0, at) + tag + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + tag.length, at + tag.length);
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/reply-template`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply_template: text }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Couldn't save.");
      else {
        setSaved(data.reply_template ?? "");
        setText(data.reply_template ?? "");
        setJustSaved(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  const hasReport = tokens.includes("report_link");
  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
          <MessageSquareReply size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base">Saved reply for hot leads</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            When a lead from this campaign replies, the inbox reply box starts with this text, filled in for that lead.
            {hasReport && (
              <>
                {" "}
                <code className="rounded bg-muted px-1">{"{{report_link}}"}</code> is their own report link: send the
                link, not the PDF (attached PDFs have landed in spam).
              </>
            )}{" "}
            You read it before it sends.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <textarea
          ref={area}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setJustSaved(false);
          }}
          rows={8}
          maxLength={5000}
          placeholder={
            hasReport
              ? "Hi {{first_name}},\n\nHere's the report: {{report_link}}\n\n{{signature}}"
              : "Hi {{first_name}},\n\n…\n\n{{signature}}"
          }
          disabled={saving}
          className="w-full resize-y rounded-lg border border-border/60 bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2E37FE]/30 disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Insert:</span>
          {tokens.map((t) => (
            <button
              key={t}
              onClick={() => insert(t)}
              disabled={saving}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium cursor-pointer hover:bg-muted ${
                t === "report_link" ? "border-[#2E37FE]/40 text-[#2E37FE]" : "border-border/60 text-muted-foreground"
              }`}
            >
              {`{{${t}}}`}
            </button>
          ))}
        </div>
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">{error}</div>}
        <div className="flex items-center justify-end gap-3">
          {justSaved && !dirty && <span className="text-xs text-emerald-700">Saved</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E37FE] px-4 py-2 text-sm font-bold text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {text.trim() ? "Save reply" : saved.trim() ? "Clear saved reply" : "Save reply"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
