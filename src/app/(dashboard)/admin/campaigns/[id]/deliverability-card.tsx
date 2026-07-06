"use client";

// Deliverability pre-flight card on the native campaign detail page. On
// demand, runs live SPF/DKIM/DMARC checks per sending domain + a copy
// spam-score, so the owner can fix issues before activating.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldCheck, CheckCircle2, AlertTriangle, XCircle, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type AuthStatus = "pass" | "warn" | "fail";
interface AuthCheck { status: AuthStatus; detail: string; }
interface DomainAuth { domain: string; spf: AuthCheck; dkim: AuthCheck; dmarc: AuthCheck; }
interface CopyIssue { severity: "warn" | "info"; message: string; }
interface CopyScore { score: number; issues: CopyIssue[]; }
interface Result { domains: DomainAuth[]; copy: CopyScore; }

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

export function DeliverabilityCard({ campaignId }: { campaignId: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/deliverability`));
      const data = (await res.json()) as Result & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Check failed.");
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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
        <Button variant="outline" size="sm" onClick={run} disabled={loading} className="gap-1.5 shrink-0">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          {result ? "Re-run" : "Run check"}
        </Button>
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
                      <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                        {iss.severity === "warn" ? (
                          <AlertTriangle size={12} className="text-amber-600 mt-0.5 shrink-0" />
                        ) : (
                          <AlertTriangle size={12} className="text-slate-400 mt-0.5 shrink-0" />
                        )}
                        {iss.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
