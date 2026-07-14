"use client";

// Deliverability pre-flight card on the native campaign detail page. On
// demand, runs live SPF/DKIM/DMARC checks per sending domain + a copy
// spam-score, so the owner can fix issues before activating.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, CheckCircle2, AlertTriangle, XCircle, Loader2 } from "lucide-react";

type AuthStatus = "pass" | "warn" | "fail";
interface AuthCheck { status: AuthStatus; detail: string; }
interface DomainAuth { domain: string; spf: AuthCheck; dkim: AuthCheck; dmarc: AuthCheck; }
interface CopyIssue { severity: "warn" | "info"; message: string; }
interface SpamMatch {
  phrase: string;
  category: string;
  severity: "high" | "med" | "low";
  alternatives?: string[];
  field: "subject" | "body";
  inSpintax: boolean;
}
interface StepCopyResult {
  stepIndex: number;
  score: number;
  issues: CopyIssue[];
  matches: SpamMatch[];
}
// perStep is optional so responses that predate the per-step breakdown still parse.
interface CopyScore { score: number; issues: CopyIssue[]; perStep?: StepCopyResult[]; }
export interface DeliverabilityResult { domains: DomainAuth[]; copy: CopyScore; }

function scoreBand(score: number): string {
  return score >= 85 ? "text-emerald-600" : score >= 60 ? "text-amber-600" : "text-red-600";
}

function IssueRow({ iss }: { iss: CopyIssue }) {
  return (
    <li className="flex items-start gap-1.5 text-xs text-muted-foreground">
      {iss.severity === "warn" ? (
        <AlertTriangle size={12} className="text-amber-600 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle size={12} className="text-slate-400 mt-0.5 shrink-0" />
      )}
      {iss.message}
    </li>
  );
}

function MatchChip({ m }: { m: SpamMatch }) {
  const tone =
    m.severity === "high"
      ? "bg-red-50 text-red-700 border-red-200"
      : m.severity === "med"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-slate-50 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${tone}`}>
      <span className="font-medium">{m.phrase}</span>
      {m.alternatives && m.alternatives.length > 0 && (
        <span className="opacity-80">→ {m.alternatives[0]}</span>
      )}
      {m.inSpintax && <span className="opacity-60">(in a spintax option)</span>}
    </span>
  );
}

function StatusIcon({ status }: { status: AuthStatus }) {
  if (status === "pass") return <CheckCircle2 size={14} className="text-emerald-600 shrink-0" />;
  if (status === "warn") return <AlertTriangle size={14} className="text-amber-600 shrink-0" />;
  return <XCircle size={14} className="text-red-600 shrink-0" />;
}

function AuthRow({ label, check }: { label: string; check: AuthCheck }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <StatusIcon status={check.status} />
      <span className="font-medium w-12 shrink-0">{label}</span>
      <span className="text-muted-foreground">{check.detail}</span>
    </div>
  );
}

// Presentational: state (result/loading/error) is owned by the parent section so
// the "Run check" trigger can live in the Sequence & schedule card header. The
// parent only mounts this card once a check has started.
export function DeliverabilityCard({
  result,
  loading,
  error,
}: {
  result: DeliverabilityResult | null;
  loading: boolean;
  error: string | null;
}) {
  const scoreColor = result
    ? result.copy.score >= 85
      ? "text-emerald-600"
      : result.copy.score >= 60
        ? "text-amber-600"
        : "text-red-600"
    : "";

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#16a34a]">
            <ShieldCheck size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Deliverability check</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Domain authentication + copy spam-signals. Advisory — run before activating.
            </p>
          </div>
        </div>
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Loader2 size={14} className="animate-spin" /> Running…
          </span>
        )}
      </CardHeader>
      {(result || error) && (
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {result && (
            <>
              {result.domains.length === 0 ? (
                <p className="text-xs text-muted-foreground">No sending mailboxes on this campaign yet.</p>
              ) : (
                <div className="space-y-3">
                  {result.domains.map((d) => (
                    <div key={d.domain} className="rounded-lg border border-border/50 p-3 space-y-1.5">
                      <p className="text-sm font-medium">{d.domain}</p>
                      <AuthRow label="SPF" check={d.spf} />
                      <AuthRow label="DKIM" check={d.dkim} />
                      <AuthRow label="DMARC" check={d.dmarc} />
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border border-border/50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Copy spam-score</p>
                  <span className={`text-lg font-bold ${scoreColor}`}>{result.copy.score}/100</span>
                </div>
                {result.copy.issues.length === 0 ? (
                  <p className="text-xs text-emerald-700 mt-1 inline-flex items-center gap-1">
                    <CheckCircle2 size={12} /> No spam signals detected.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {result.copy.issues.map((iss, i) => (
                      <IssueRow key={i} iss={iss} />
                    ))}
                  </ul>
                )}

                {result.copy.perStep && result.copy.perStep.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
                    {result.copy.perStep.map((step) => (
                      <div key={step.stepIndex} className="rounded-md border border-border/40 p-2.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium">Step {step.stepIndex + 1}</p>
                          <span className={`text-sm font-semibold ${scoreBand(step.score)}`}>
                            {step.score}/100
                          </span>
                        </div>
                        {step.issues.length > 0 && (
                          <ul className="mt-1.5 space-y-1">
                            {step.issues.map((iss, i) => (
                              <IssueRow key={i} iss={iss} />
                            ))}
                          </ul>
                        )}
                        {step.matches.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {step.matches.map((m, i) => (
                              <MatchChip key={i} m={m} />
                            ))}
                          </div>
                        )}
                        {step.issues.length === 0 && step.matches.length === 0 && (
                          <p className="text-xs text-emerald-700 mt-1 inline-flex items-center gap-1">
                            <CheckCircle2 size={12} /> Clean.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
