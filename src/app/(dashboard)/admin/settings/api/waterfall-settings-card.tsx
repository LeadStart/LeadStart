"use client";

// Enrichment waterfall — org-level config for the second-pass email waterfall
// (migration 00075): master toggle, company-size routing (small/large/unknown
// bands split at an employee-count threshold), and the catch-all toggle. Default
// method is pattern_mv; site_scrape/scrape_plus_pattern need the private actor,
// bovi is the opt-in pay-per-found fallback.

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

// Available methods. site_scrape + scrape_plus_pattern need the private Apify
// actor deployed (apify-actors/site-contact-scraper) — see the hint below.
const METHOD_OPTIONS: { value: EnrichmentWaterfallMethod; label: string }[] = [
  { value: "pattern_mv", label: "Pattern + verify (Million Verifier)" },
  { value: "scrape_plus_pattern", label: "Site scrape, then pattern + verify" },
  { value: "site_scrape", label: "Site scrape (phone + generic email + personal)" },
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
  // Local text state for the numeric field so partial typing doesn't fight the
  // clamp; committed on save.
  const [thresholdText, setThresholdText] = useState("");

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
            {/* auto-run kill-switch — the Prospecting → Contacts → Enrich flow */}
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={settings.auto_run_after_search}
                onChange={(e) =>
                  setSettings({ ...settings, auto_run_after_search: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
              />
              <span>
                Auto-run pipeline after a LinkedIn search
                <span className="block text-[11px] text-muted-foreground">
                  When on, a finished Prospecting search imports every sourced person into
                  Contacts and starts enrichment automatically. Off = curate the list first
                  and click Import to Contacts yourself.
                </span>
              </span>
            </label>

            {/* domain discovery — independent of the waterfall master toggle */}
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={settings.domain_discovery_enabled}
                onChange={(e) =>
                  setSettings({ ...settings, domain_discovery_enabled: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
              />
              <span>
                Discover websites for companies without a LinkedIn page
                <span className="block text-[11px] text-muted-foreground">
                  During the domain step, a web lookup (Perplexity or Claude) finds the
                  company&apos;s website when it has no LinkedIn page — validated against the
                  live site before saving, so the email waterfall can still run. ≈ $0.005/company.
                </span>
              </span>
            </label>

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
                Each contact is routed to its band&apos;s method by employee count
                (contacts with no count use the Unknown method). The two site-scrape
                methods need the private scraper actor deployed first
                (apify-actors/site-contact-scraper). Off in every band disables the
                second pass.
              </p>
            </div>

            {/* catch-all toggle — live in Phase 2 (pattern_mv) */}
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={settings.accept_catch_all_guesses}
                onChange={(e) =>
                  setSettings({ ...settings, accept_catch_all_guesses: e.target.checked })
                }
                className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
              />
              <span>
                Accept catch-all pattern guesses
                <span className="block text-[11px] text-muted-foreground">
                  For the pattern method: when on, a guess that verifies as
                  catch-all is still written (flagged risky, low confidence); the
                  pre-send gate re-checks it either way. Off = only clean-verified
                  addresses are kept.
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
