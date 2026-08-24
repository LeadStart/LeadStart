"use client";

// Enrichment waterfall — org-level config for the second-pass email waterfall
// (migration 00075): master toggle, company-size routing (small/large/unknown
// bands split at an employee-count threshold), the vdrmota per-company lead cap,
// and the (Phase-2) catch-all toggle. Phase 1 offers only the methods that exist
// today (vdrmota / bovi / off); pattern_mv + site_scrape appear as they ship.

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SlidersHorizontal, CheckCircle, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { EnrichmentSettings, EnrichmentWaterfallMethod } from "@/types/app";

// Phase-1 method menu. The full union has more members (pattern_mv,
// site_scrape, scrape_plus_pattern) — they join this list as their phases ship.
const METHOD_OPTIONS: { value: EnrichmentWaterfallMethod; label: string }[] = [
  { value: "vdrmota", label: "Directory scrape (vdrmota)" },
  { value: "bovi", label: "Pattern finder (bovi)" },
  { value: "off", label: "Off — skip this band" },
];

const BANDS: { key: "small_method" | "large_method" | "unknown_method"; label: string; hint: string }[] = [
  { key: "small_method", label: "Small companies", hint: "below the threshold" },
  { key: "large_method", label: "Large companies", hint: "at or above the threshold" },
  { key: "unknown_method", label: "Unknown size", hint: "no employee count on record" },
];

export function WaterfallSettingsCard() {
  const [settings, setSettings] = useState<EnrichmentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Local text state for the numeric fields so partial typing doesn't fight the
  // clamp; committed on save.
  const [thresholdText, setThresholdText] = useState("");
  const [leadCapText, setLeadCapText] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(appUrl("/api/admin/enrichment/settings"), { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) {
        setLoadError(d.error ?? `Failed to load settings (${res.status})`);
        return;
      }
      const s = d.settings as EnrichmentSettings;
      setSettings(s);
      setThresholdText(String(s.size_threshold));
      setLeadCapText(String(s.vdrmota_max_leads));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load settings");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const res = await fetch(appUrl("/api/admin/enrichment/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            ...settings,
            size_threshold: thresholdText.trim() === "" ? settings.size_threshold : Number(thresholdText),
            vdrmota_max_leads: leadCapText.trim() === "" ? settings.vdrmota_max_leads : Number(leadCapText),
          },
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setSaveError(d.error ?? `Save failed (${res.status})`);
        return;
      }
      // Reflect the server-clamped values back into the form.
      const s = d.settings as EnrichmentSettings;
      setSettings(s);
      setThresholdText(String(s.size_threshold));
      setLeadCapText(String(s.vdrmota_max_leads));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const enabled = settings?.waterfall_enabled ?? true;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
          <SlidersHorizontal size={16} className="text-white" />
        </div>
        <div>
          <CardTitle className="text-base">Enrichment waterfall</CardTitle>
          <p className="text-xs text-muted-foreground">
            Controls the second-pass email search in Contacts &rarr; Enrich: which
            method runs per company size, and how much each company may cost.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <span>{loadError}</span>
          </div>
        ) : !settings ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Loading waterfall settings…
          </div>
        ) : (
          <>
            {/* master toggle */}
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={settings.waterfall_enabled}
                onChange={(e) =>
                  setSettings({ ...settings, waterfall_enabled: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
              />
              <span>
                Run the second-pass waterfall
                <span className="block text-[11px] text-muted-foreground">
                  When off, enrichment runs stop after the LinkedIn profile + domain
                  steps — no second-pass email search is billed.
                </span>
              </span>
            </label>

            {/* size threshold */}
            <div className="space-y-1">
              <Label htmlFor="wfThreshold" className="text-sm font-medium">
                Company-size threshold (employees)
              </Label>
              <Input
                id="wfThreshold"
                type="number"
                min={1}
                max={100000}
                value={thresholdText}
                onChange={(e) => setThresholdText(e.target.value)}
                disabled={!enabled}
                className="max-w-[220px]"
              />
              <p className="text-[11px] text-muted-foreground">
                Companies at or above this employee count use the Large method;
                below it, the Small method. Company sites of large companies rarely
                publish a decision-maker&apos;s email, so a cheaper targeted method
                fits them better.
              </p>
            </div>

            {/* per-band methods */}
            <div className="space-y-2.5">
              {BANDS.map((band) => (
                <div key={band.key} className="flex items-center gap-3">
                  <div className="w-44 shrink-0">
                    <span className="text-sm font-medium">{band.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{band.hint}</span>
                  </div>
                  <Select
                    value={settings[band.key]}
                    onValueChange={(v) =>
                      v && setSettings({ ...settings, [band.key]: v as EnrichmentWaterfallMethod })
                    }
                  >
                    <SelectTrigger className="w-[240px]" disabled={!enabled}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHOD_OPTIONS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Pattern+verify (Million Verifier) and our own site scraper join this
                list as they ship. Until per-size routing lands, one method runs for
                the whole run: the first directory/pattern method among Unknown
                &rarr; Small &rarr; Large. Off everywhere disables the second pass.
              </p>
            </div>

            {/* vdrmota lead cap */}
            <div className="space-y-1">
              <Label htmlFor="wfLeadCap" className="text-sm font-medium">
                Directory leads per company (vdrmota)
              </Label>
              <Input
                id="wfLeadCap"
                type="number"
                min={1}
                max={10}
                value={leadCapText}
                onChange={(e) => setLeadCapText(e.target.value)}
                disabled={!enabled}
                className="max-w-[220px]"
              />
              <p className="text-[11px] text-muted-foreground">
                Each lead pulled is billed (&asymp;$0.005 on a paid Apify plan,
                &asymp;$0.10 on the free tier) whether or not it matches your
                contact. 1&ndash;10; lower = cheaper, higher = better odds the
                directory dump contains your person.
              </p>
            </div>

            {/* catch-all toggle — Phase 2 */}
            <label className="flex items-start gap-2 text-sm cursor-not-allowed opacity-60">
              <input
                type="checkbox"
                checked={settings.accept_catch_all_guesses}
                disabled
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                Accept catch-all pattern guesses
                <span className="block text-[11px] text-muted-foreground">
                  Arrives with the pattern+verify method. When on, a pattern guess
                  that verifies as catch-all is still written (flagged risky); the
                  pre-send gate re-checks it either way.
                </span>
              </span>
            </label>

            <div className="flex gap-2 items-center">
              <Button onClick={handleSave} disabled={saving} style={{ background: "#2E37FE" }}>
                {saving ? "Saving..." : "Save"}
              </Button>
              {saved && (
                <span className="text-sm text-emerald-600 flex items-center gap-1">
                  <CheckCircle size={14} /> Saved
                </span>
              )}
            </div>
            {saveError && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                <XCircle size={16} className="text-red-500" />
                <span className="text-sm font-medium text-red-700">Save failed: {saveError}</span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
