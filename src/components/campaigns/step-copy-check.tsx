"use client";

// Shared per-step copy feedback that sits directly under a step's body textarea
// in the campaign builders. Purely advisory — it never blocks saving or sending.
//
// Shows, when there's anything to say:
//   1. Spintax variant counts.
//   2. Spintax validation warnings in plain language.
//   3. Spam-trigger phrase chips (severity-colored) with suggested rewrites.
//   4. A "Generate spintax" action (only when onApplySpintax is provided) that
//      asks Claude to rewrite the copy, previewed before/after in a dialog and
//      applied to the form only on explicit accept.
//   5. A "Preview" toggle that renders the outgoing email with {{tokens}} filled
//      from a REAL contact (fetched via campaignId/clientId) and spintax resolved
//      to one variant, with a Regenerate button to re-roll. Falls back to sample
//      values when no real contact exists.

import { useMemo, useState } from "react";
import { Eye, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { appUrl } from "@/lib/api-url";
import { useDebounced } from "@/hooks/use-debounced";
import {
  parseSpintax,
  countVariants,
  hasSpintax,
  renderSpintax,
  type SpintaxWarning,
} from "@/lib/spintax";
import { findSpamMatches, type SpamMatch } from "@/lib/deliverability/copy";
import { applyTokens, SAMPLE_TOKENS, sampleFallback } from "@/lib/native/tokens";

interface Props {
  subject: string;
  body: string;
  onApplySpintax?: (next: { subject: string | null; body: string }) => void;
  // One of these identifies where to pull a real contact for the live preview.
  // When neither is set, the preview uses sample data only.
  campaignId?: string;
  clientId?: string;
}

// GET /api/admin/campaign-preview-context response shape.
interface PreviewContext {
  contactLabel: string | null;
  tokens: Record<string, string> | null;
}

const VARIANT_CAP = 10000;

function formatCount(n: number): string {
  return n >= VARIANT_CAP ? "10,000+" : n.toLocaleString("en-US");
}

// Severity → chip variant color. High = red, med = amber, low = slate.
function chipClass(severity: SpamMatch["severity"]): string {
  if (severity === "high") return "bg-red-50 text-red-700 border-red-200";
  if (severity === "med") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

function warnClass(code: SpintaxWarning["code"]): string {
  return code === "unbalanced_brace" ? "text-amber-700" : "text-slate-500";
}

function SpamChip({ match }: { match: SpamMatch }) {
  const alt = match.alternatives && match.alternatives.length > 0 ? match.alternatives[0] : null;
  return (
    <Badge
      variant="outline"
      className={`h-auto whitespace-normal py-0.5 ${chipClass(match.severity)}`}
    >
      <span className="font-medium">{match.phrase}</span>
      {alt && (
        <span className="font-normal">
          {" → "}
          {`"${alt}"`}
        </span>
      )}
      <span className="ml-1 opacity-70">{match.category}</span>
      {match.inSpintax && <span className="ml-1 opacity-70">(in a spintax option)</span>}
    </Badge>
  );
}

interface GenState {
  loading: boolean;
  error: string | null;
  result: { subject: string | null; body: string } | null;
}

export function StepCopyCheck({ subject, body, onApplySpintax, campaignId, clientId }: Props) {
  const dSubject = useDebounced(subject, 300);
  const dBody = useDebounced(body, 300);

  const analysis = useMemo(() => {
    const subjParsed = parseSpintax(dSubject);
    const bodyParsed = parseSpintax(dBody);
    const subjectHasSpin = hasSpintax(dSubject);
    const bodyHasSpin = hasSpintax(dBody);

    // Dedupe spintax warnings by message across both fields.
    const warnings: SpintaxWarning[] = [];
    const seenWarn = new Set<string>();
    for (const w of [...subjParsed.warnings, ...bodyParsed.warnings]) {
      if (seenWarn.has(w.message)) continue;
      seenWarn.add(w.message);
      warnings.push(w);
    }

    const spamMatches: SpamMatch[] = [
      ...findSpamMatches(dSubject, "subject"),
      ...findSpamMatches(dBody, "body"),
    ];

    return {
      subjectHasSpin,
      bodyHasSpin,
      anySpin: subjectHasSpin || bodyHasSpin,
      subjectVariants: subjectHasSpin ? countVariants(dSubject) : 0,
      bodyVariants: bodyHasSpin ? countVariants(dBody) : 0,
      warnings,
      spamMatches,
    };
  }, [dSubject, dBody]);

  // ── Live preview ──────────────────────────────────────────────────────────
  // A toggle-open panel that renders the outgoing email with spintax resolved to
  // one variant and {{tokens}} filled from a REAL contact (fetched once, cached)
  // — or from sample values when no real contact exists. Regenerate re-rolls the
  // spintax variant against the same token map. Preview only; never the send path.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [ctx, setCtx] = useState<PreviewContext | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [ctxFetched, setCtxFetched] = useState(false);
  const [nonce, setNonce] = useState(0); // re-roll seed for Regenerate

  async function openPreview() {
    setPreviewOpen(true);
    // Fetch the real-contact context once; sample mode needs no fetch.
    if (ctxFetched || ctxLoading || (!campaignId && !clientId)) return;
    setCtxLoading(true);
    try {
      const qs = campaignId
        ? `campaignId=${encodeURIComponent(campaignId)}`
        : `clientId=${encodeURIComponent(clientId!)}`;
      const res = await fetch(appUrl(`/api/admin/campaign-preview-context?${qs}`));
      if (res.ok) {
        setCtx((await res.json()) as PreviewContext);
      }
    } catch {
      // Silent — fall back to sample mode below.
    } finally {
      setCtxLoading(false);
      setCtxFetched(true);
    }
  }

  // REAL mode when we fetched a non-null token map; otherwise SAMPLE mode.
  const realTokens = ctx?.tokens ?? null;
  const isSample = realTokens === null;
  const tokenMap = realTokens ?? SAMPLE_TOKENS;

  // Resolve spintax (seeded by nonce so subject+body are one coherent render),
  // then fill tokens. In sample mode, sampleFallback fills unknown tokens so
  // nothing reads as a raw {{placeholder}}; in real mode unknown tokens stay
  // literal, exactly like the real send.
  const preview = useMemo(() => {
    if (!dBody.trim()) return null;
    const seed = `preview:${nonce}`;
    const fill = (t: string) => applyTokens(t, tokenMap, isSample ? sampleFallback : undefined);
    return {
      subject: dSubject.trim() ? fill(renderSpintax(dSubject, seed)) : "",
      body: fill(renderSpintax(dBody, seed)),
    };
  }, [dSubject, dBody, nonce, tokenMap, isSample]);

  // Regenerate: advance to the next seed whose spintax render actually differs
  // from the current one, so a click always visibly changes the preview (with few
  // options, consecutive seeds can otherwise land on the same variant). Token fill
  // is identical across seeds, so comparing the pre-fill spintax render suffices.
  function regenerate() {
    setNonce((n) => {
      const at = (m: number) =>
        renderSpintax(dSubject, `preview:${m}`) + "" + renderSpintax(dBody, `preview:${m}`);
      const current = at(n);
      for (let m = n + 1; m <= n + 64; m++) {
        if (at(m) !== current) return m;
      }
      return n + 1; // only one distinct variant — nothing more to show
    });
  }

  const nothingToSay =
    !analysis.anySpin && analysis.spamMatches.length === 0 && analysis.warnings.length === 0;

  // Generate-spintax dialog state.
  const [genOpen, setGenOpen] = useState(false);
  const [gen, setGen] = useState<GenState>({ loading: false, error: null, result: null });

  async function runGenerate() {
    setGen({ loading: true, error: null, result: null });
    try {
      const res = await fetch(appUrl("/api/admin/ai/spintax"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject && subject.length ? subject : null,
          body,
        }),
      });
      const data = (await res.json()) as {
        subject?: string | null;
        body?: string;
        error?: string;
      };
      if (!res.ok) {
        setGen({ loading: false, error: data.error ?? "Generation failed.", result: null });
        return;
      }
      setGen({
        loading: false,
        error: null,
        result: { subject: data.subject ?? null, body: data.body ?? "" },
      });
    } catch (err) {
      setGen({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        result: null,
      });
    }
  }

  function openGenerate() {
    setGenOpen(true);
    runGenerate();
  }

  function applyGenerated() {
    if (!gen.result || !onApplySpintax) return;
    onApplySpintax({ subject: gen.result.subject, body: gen.result.body });
    setGenOpen(false);
    toast.success("Spintax applied — remember to save");
  }

  const canPreview = dBody.trim().length > 0;

  // Render nothing only when the step is clean, there's no generator to offer,
  // and there's no body to preview.
  if (nothingToSay && !onApplySpintax && !canPreview) return null;

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border/50 bg-muted/30 p-2.5 text-xs">
      {!nothingToSay && (
        <div className="space-y-2">
          {/* 1. Spintax variant counts */}
          {analysis.anySpin && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
              <span className="font-medium text-foreground">Spintax</span>
              <span>— Body: {formatCount(analysis.bodyVariants)} variants</span>
              {analysis.subjectHasSpin && (
                <span>· Subject: {formatCount(analysis.subjectVariants)} variants</span>
              )}
            </div>
          )}

          {/* 2. Spintax warnings */}
          {analysis.warnings.length > 0 && (
            <ul className="space-y-0.5">
              {analysis.warnings.map((w) => (
                <li key={w.code} className={warnClass(w.code)}>
                  {w.message}
                </li>
              ))}
            </ul>
          )}

          {/* 3. Spam-phrase chips */}
          {analysis.spamMatches.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {analysis.spamMatches.map((m) => (
                <SpamChip key={`${m.field}:${m.phrase}`} match={m} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 4. Actions: Preview + Generate spintax */}
      {(canPreview || onApplySpintax) && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {canPreview && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-[11px]"
              onClick={() => (previewOpen ? setPreviewOpen(false) : openPreview())}
            >
              <Eye size={12} /> {previewOpen ? "Hide preview" : "Preview"}
            </Button>
          )}
          {onApplySpintax && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-[11px]"
              onClick={openGenerate}
            >
              <Sparkles size={12} /> Generate spintax
            </Button>
          )}
        </div>
      )}

      {/* 5. Live preview panel */}
      {previewOpen && canPreview && (
        <div className="rounded-md border border-border/50 bg-background p-2.5">
          {ctxLoading ? (
            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              Loading preview…
            </div>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {isSample
                    ? "Preview — sample data (no contacts loaded yet)"
                    : `Preview — as ${ctx?.contactLabel ?? "your contact"} will receive it`}
                </span>
                {analysis.anySpin && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-[11px]"
                    onClick={regenerate}
                  >
                    <RefreshCw size={11} /> Regenerate
                  </Button>
                )}
              </div>
              {preview?.subject && (
                <pre className="mb-1 whitespace-pre-wrap break-words font-sans text-[11px] font-semibold text-foreground">
                  {preview.subject}
                </pre>
              )}
              <pre className="whitespace-pre-wrap break-words font-sans text-[11px] text-muted-foreground">
                {preview?.body}
              </pre>
            </>
          )}
        </div>
      )}

      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate spintax</DialogTitle>
          </DialogHeader>

          {gen.loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              Rewriting your copy with spintax variations…
            </div>
          )}

          {!gen.loading && gen.error && (
            <p className="py-6 text-sm text-red-600">{gen.error}</p>
          )}

          {!gen.loading && gen.result && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Before
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatCount(countVariants(body))} variants
                  </span>
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/30 p-2 font-sans text-xs">
                  {(subject && subject.length ? subject + "\n\n" : "") + body}
                </pre>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                    After
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatCount(countVariants(gen.result.body))} variants
                  </span>
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-emerald-200 bg-emerald-50/40 p-2 font-sans text-xs">
                  {(gen.result.subject ? gen.result.subject + "\n\n" : "") + gen.result.body}
                </pre>
              </div>
            </div>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Discard</DialogClose>
            <Button
              type="button"
              onClick={applyGenerated}
              disabled={gen.loading || !gen.result}
              style={{ background: "#2E37FE" }}
              className="text-white"
            >
              Use this
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
