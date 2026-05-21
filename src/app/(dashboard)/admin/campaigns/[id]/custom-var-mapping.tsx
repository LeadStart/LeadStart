"use client";

// Custom-variable mapping panel on the campaign detail page.
//
// Renders one row per Salesforge custom variable defined in the
// workspace. Each row has a dropdown listing LeadStart contact
// columns (or "— Don't send —" to skip). User picks the column whose
// value should populate that variable when the dispatcher bulk-creates
// contacts in Salesforge. No JSON, no free text, no typo risk.
//
// If the workspace has zero custom variables defined, the panel
// explains how to add them in app.salesforge.ai and the mapping
// section stays inert until variables exist.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Variable,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface SalesforgeVarLite {
  id?: string;
  name?: string;
  description?: string;
  defaultValue?: string;
}

// Allowed LeadStart contact columns the dispatcher can pull values
// from. Kept in sync with ALLOWED_MAPPING_TARGETS in
// /api/admin/campaigns/[id]/update-custom-vars and the SELECT in
// the dispatcher cron.
const LEAD_FIELDS: { value: string; label: string }[] = [
  { value: "first_name", label: "first_name" },
  { value: "last_name", label: "last_name" },
  { value: "email", label: "email" },
  { value: "company_name", label: "company_name" },
  { value: "title", label: "title" },
  { value: "phone", label: "phone" },
  { value: "linkedin_url", label: "linkedin_url" },
  { value: "intro_line", label: "intro_line" },
  { value: "notes", label: "notes" },
];

const UNMAPPED = "__unmapped__";

export function CustomVarMapping({
  campaignId,
  currentMapping,
}: {
  campaignId: string;
  currentMapping: Record<string, string> | null;
}) {
  const router = useRouter();
  const [vars, setVars] = useState<SalesforgeVarLite[] | null>(null);
  const [varsError, setVarsError] = useState<string | null>(null);
  const [loadingVars, setLoadingVars] = useState(true);

  // Per-variable selection: salesforge var name → leadstart column
  // (or UNMAPPED).
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Initial selections derive from currentMapping (variables not in
  // the mapping default to UNMAPPED).
  const initialSelections = useMemo(() => {
    const out: Record<string, string> = {};
    if (currentMapping) {
      for (const [sfName, leadField] of Object.entries(currentMapping)) {
        out[sfName] = leadField;
      }
    }
    return out;
  }, [currentMapping]);

  useEffect(() => {
    setSelections(initialSelections);
  }, [initialSelections]);

  // Load workspace's defined custom variables.
  useEffect(() => {
    let active = true;
    (async () => {
      setLoadingVars(true);
      setVarsError(null);
      try {
        const res = await fetch(
          appUrl(`/api/admin/campaigns/${campaignId}/salesforge-custom-vars`),
        );
        const data = (await res.json()) as {
          ok?: boolean;
          custom_vars?: SalesforgeVarLite[];
          error?: string;
        };
        if (!active) return;
        if (!res.ok || !data.ok) {
          setVarsError(data.error ?? `Failed (HTTP ${res.status})`);
          setVars([]);
        } else {
          setVars((data.custom_vars ?? []).filter((v) => v.name));
        }
      } catch (err) {
        if (!active) return;
        setVarsError(err instanceof Error ? err.message : String(err));
        setVars([]);
      } finally {
        if (active) setLoadingVars(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [campaignId]);

  function updateSelection(sfName: string, value: string) {
    setSelections((prev) => ({ ...prev, [sfName]: value }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  }

  async function handleSave() {
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      // Build the mapping: include only entries with a real lead field.
      const mapping: Record<string, string> = {};
      for (const [sfName, leadField] of Object.entries(selections)) {
        if (leadField && leadField !== UNMAPPED) {
          mapping[sfName] = leadField;
        }
      }
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/update-custom-vars`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mapping: Object.keys(mapping).length > 0 ? mapping : null,
          }),
        },
      );
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setSaveError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSaved(true);
      setDirty(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const hasVars = vars && vars.length > 0;

  return (
    <Card className="border-border/50 shadow-sm">
      <div className="flex items-center gap-2 px-5 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
          <Variable size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold leading-none">
            Custom variable mapping
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            For each <code>{`{{name}}`}</code> placeholder your Salesforge
            sequence uses, pick which LeadStart contact column the
            dispatcher should send. Standard variables
            (<code>{`{{firstName}}`}</code>, <code>{`{{lastName}}`}</code>,{" "}
            <code>{`{{company}}`}</code>, etc.) are auto-populated — no mapping
            needed for those.
          </p>
        </div>
      </div>
      <CardContent className="pt-4 space-y-3">
        {loadingVars && (
          <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <Loader2 size={11} className="animate-spin" /> Loading Salesforge
            custom variables…
          </p>
        )}

        {varsError && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <p>Couldn&apos;t load workspace custom variables: {varsError}</p>
          </div>
        )}

        {!loadingVars && !varsError && !hasVars && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <p className="font-medium mb-1">
              No custom variables defined in your Salesforge workspace yet
            </p>
            <p>
              Add them in{" "}
              <a
                href="https://app.salesforge.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5"
              >
                app.salesforge.ai
                <ExternalLink size={10} />
              </a>{" "}
              → Settings → Custom variables, then reference them in your step
              copy (e.g. <code>{`{{ice_breaker}}`}</code>) and come back here to
              map each to a LeadStart contact column.
            </p>
          </div>
        )}

        {!loadingVars && !varsError && hasVars && (
          <>
            <div className="rounded-md border border-border/60 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      Salesforge variable
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      LeadStart contact column
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vars!.map((v) => {
                    const sfName = v.name!;
                    const value = selections[sfName] ?? UNMAPPED;
                    return (
                      <tr key={sfName} className="border-t border-border/40">
                        <td className="px-3 py-2 align-top">
                          <code className="text-[#2E37FE]">{`{{${sfName}}}`}</code>
                          {v.description && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {v.description}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={value}
                            onChange={(e) =>
                              updateSelection(sfName, e.target.value)
                            }
                            disabled={saving || isPending}
                            className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
                          >
                            <option value={UNMAPPED}>— Don&apos;t send —</option>
                            {LEAD_FIELDS.map((f) => (
                              <option key={f.value} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {saveError && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <p>{saveError}</p>
              </div>
            )}
            {saved && !saveError && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                <p>Saved. The next dispatcher run will use this mapping.</p>
              </div>
            )}

            <Button
              onClick={handleSave}
              disabled={saving || isPending || !dirty}
              size="sm"
            >
              {saving || isPending ? (
                <>
                  <Loader2 size={12} className="mr-1 animate-spin" /> Saving…
                </>
              ) : (
                "Save mapping"
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
