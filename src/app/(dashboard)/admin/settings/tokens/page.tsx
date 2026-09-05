"use client";

// Tokens: contact-sourcing product config. Reads + writes the real config
// (token_pricing_config singleton, token_price_tiers, token_packs) through
// /api/admin/tokens/config (owner-only, service-role writes). Prices left blank
// are stored NULL and a pack stays unpurchasable until priced.

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { appUrl } from "@/lib/api-url";
import { Coins, MapPin, ShieldCheck, CopyCheck, Database, RefreshCw, Info, Save, Loader2 } from "lucide-react";

function LinkedinIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
    </svg>
  );
}

interface Tier { id: string; vein: string; tier_key: string; token_price: number | null; is_free: boolean; is_bundled: boolean; sort: number; }
interface Pack { id: string; name: string; tokens: number; price_usd: number | null; active: boolean; sort: number; }
interface Config { [k: string]: number | null | string | undefined; version?: number; }

// Human labels for the seeded tier_keys (the engine/pricing keys stay canonical).
const TIER_LABELS: Record<string, { name: string; desc: string; cost: string }> = {
  record: { name: "Record", desc: "Business/person + phone + domain, no email", cost: "~$0.004" },
  company_inbox: { name: "Company inbox", desc: "Generic/scraped info@, the paid floor", cost: "~$0.007" },
  owner_name: { name: "Owner name", desc: "Decision-maker named", cost: "~$0.015" },
  personal_email: { name: "Personal email", desc: "Person-shaped address (unverified)", cost: "~$0.01–0.02" },
  verified_personal_email: { name: "Verified personal email", desc: "MV-confirmed clean, premium", cost: "~$0.08" },
  catch_all_guess: { name: "Catch-all guess", desc: "Pattern guess, labeled, never sold as verified", cost: "~$0.00" },
  catch_all_recovered: { name: "Catch-all recovered (Findymail)", desc: "Deliverable email on a catch-all domain", cost: "~$0.05/hit" },
};

function numOrEmpty(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

function PriceCard({
  title,
  description,
  icon,
  color,
  veinTiersList,
  onPrice,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  veinTiersList: Tier[];
  onPrice: (id: string, raw: string) => void;
}) {
  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: color }}>{icon}</div>
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="hidden grid-cols-[1fr_auto_140px] items-center gap-4 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
          <span>Package</span><span className="text-right">Our cost</span><span className="text-right">Token price</span>
        </div>
        {veinTiersList.map((tier) => {
          const meta = TIER_LABELS[tier.tier_key] ?? { name: tier.tier_key, desc: "", cost: "" };
          return (
            <div key={tier.id} className="grid grid-cols-1 items-center gap-2 rounded-lg border border-border/50 px-3 py-2.5 sm:grid-cols-[1fr_auto_140px] sm:gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{meta.name}</span>
                  {tier.is_free && <Badge className="badge-green">Free · on us</Badge>}
                  {tier.is_bundled && <Badge className="badge-slate">Bundled</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{meta.desc}</p>
              </div>
              <span className="text-right font-mono text-xs text-muted-foreground">{meta.cost}</span>
              <div className="text-right">
                {tier.is_free || tier.is_bundled ? (
                  <span className="text-sm text-muted-foreground">—</span>
                ) : (
                  <div className="flex items-center justify-end gap-1">
                    <Input type="number" min={0} step="0.1" value={numOrEmpty(tier.token_price)} onChange={(e) => onPrice(tier.id, e.target.value)} placeholder="0" className="h-8 w-20 text-right" />
                    <span className="text-xs text-muted-foreground">tok</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function TokensSettingsPage() {
  const [config, setConfig] = useState<Config>({});
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(appUrl("/api/admin/tokens/config"))
      .then((r) => r.json())
      .then((d) => {
        setConfig((d.config as Config) ?? {});
        setTiers((d.tiers as Tier[]) ?? []);
        setPacks((d.packs as Pack[]) ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const setCfg = useCallback((key: string, raw: string) => {
    setConfig((c) => ({ ...c, [key]: raw === "" ? null : Number(raw) }));
    setSaved(false);
  }, []);
  const setTierPrice = useCallback((id: string, raw: string) => {
    setTiers((ts) => ts.map((t) => (t.id === id ? { ...t, token_price: raw === "" ? null : Number(raw) } : t)));
    setSaved(false);
  }, []);
  const setPackField = useCallback((id: string, field: "price_usd", raw: string) => {
    setPacks((ps) => ps.map((p) => (p.id === id ? { ...p, [field]: raw === "" ? null : Number(raw) } : p)));
    setSaved(false);
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(appUrl("/api/admin/tokens/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config,
          tiers: tiers.map((t) => ({ vein: t.vein, tier_key: t.tier_key, token_price: t.token_price })),
          packs: packs.map((p) => ({ id: p.id, price_usd: p.price_usd })),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error || "Save failed.");
      } else {
        setSaved(true);
      }
    } catch {
      setError("Network error.");
    }
    setSaving(false);
  }

  const cfgNum = (k: string) => numOrEmpty(config[k] as number | null | undefined);
  const veinTiers = (vein: string) => tiers.filter((t) => t.vein === vein).sort((a, b) => a.sort - b.sort);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>Prices left blank are stored as unset; a pack stays unpurchasable until it has a price. Saving bumps the price-card version that charges snapshot.</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
          <Button style={{ background: "#2E37FE" }} onClick={save} disabled={saving || loading}>
            {saving ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Save size={14} className="mr-1" />}
            Save
          </Button>
        </div>
      </div>

      {/* Token economics */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]"><Coins size={16} className="text-white" /></div>
          <div><CardTitle className="text-base">Token economics</CardTitle><p className="text-xs text-muted-foreground">What one token is worth, the markup over fully-loaded cost, and the Stripe packs buyers purchase.</p></div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Token unit value (USD)</Label>
              <Input type="number" step="0.01" value={cfgNum("token_unit_usd")} onChange={(e) => setCfg("token_unit_usd", e.target.value)} placeholder="0.10" className="max-w-[220px]" />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Target markup (×)</Label>
              <Input type="number" step="0.1" value={cfgNum("target_markup")} onChange={(e) => setCfg("target_markup", e.target.value)} placeholder="3" className="max-w-[220px]" />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Token packs (Stripe one-time)</Label>
            {packs.map((pack) => (
              <div key={pack.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-lg border border-border/50 px-3 py-2.5">
                <span className="text-sm font-medium">{pack.name}</span>
                <span className="text-xs text-muted-foreground">{pack.tokens.toLocaleString()} tokens</span>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">$</span>
                  <Input type="number" value={numOrEmpty(pack.price_usd)} onChange={(e) => setPackField(pack.id, "price_usd", e.target.value)} placeholder="0" className="h-8 w-24 text-right" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <PriceCard title="Maps vein: price card" description="Local-business sourcing. Cheap sourcing + two cheap floors; price per delivered outcome." icon={<MapPin size={16} className="text-white" />} color="#059669" veinTiersList={veinTiers("maps")} onPrice={setTierPrice} />
      <PriceCard title="LinkedIn vein: price card" description="Person-first sourcing. Pricier sourcing, richer record; separate prices from Maps." icon={<LinkedinIcon size={16} className="text-white" />} color="#0A66C2" veinTiersList={veinTiers("linkedin")} onPrice={setTierPrice} />

      {/* Spend safety */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-600"><ShieldCheck size={16} className="text-white" /></div>
          <div><CardTitle className="text-base">Spend safety</CardTitle><p className="text-xs text-muted-foreground">Pre-fund only, then reserve → cap → settle. Buyers can never trigger more vendor spend than they&apos;ve pre-paid.</p></div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Max rows per search</Label>
            <Input type="number" value={cfgNum("max_rows_per_search")} onChange={(e) => setCfg("max_rows_per_search", e.target.value)} placeholder="1000" className="max-w-[220px]" />
          </div>
          <div className="space-y-1">
            <Label className="text-sm font-medium">Max charge per run (USD)</Label>
            <Input type="number" step="0.5" value={cfgNum("max_charge_per_run_usd")} onChange={(e) => setCfg("max_charge_per_run_usd", e.target.value)} placeholder="25" className="max-w-[220px]" />
            <p className="text-[11px] text-muted-foreground">Passed to the actor as <span className="font-mono">maxTotalChargeUsd</span> on buyer runs, a hard ceiling. Agency runs keep their own caps.</p>
          </div>
        </CardContent>
      </Card>

      {/* Dedup, coverage & re-verify */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600"><CopyCheck size={16} className="text-white" /></div>
          <div><CardTitle className="text-base">Dedup, coverage &amp; re-verify</CardTitle><p className="text-xs text-muted-foreground">Per-buyer dedup, a segment cache so repeat pulls don&apos;t re-source, and a cheap re-verify tier.</p></div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
            <div><p className="text-sm font-medium">Per-buyer dedup</p><p className="text-xs text-muted-foreground">Charge only net-new; skip enrichment on contacts a buyer already owns.</p></div>
            <Badge className="badge-green">Always on</Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Segment cache freshness (days)</Label>
              <Input type="number" value={cfgNum("segment_cache_freshness_days")} onChange={(e) => setCfg("segment_cache_freshness_days", e.target.value)} placeholder="45" className="max-w-[220px]" />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Re-verify token price</Label>
              <Input type="number" value={cfgNum("reverify_token_price")} onChange={(e) => setCfg("reverify_token_price", e.target.value)} placeholder="1" className="max-w-[220px]" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-sm font-medium">Auto re-verify owned contacts older than (days)</Label>
            <Input type="number" value={cfgNum("auto_reverify_days")} onChange={(e) => setCfg("auto_reverify_days", e.target.value)} placeholder="30" className="max-w-[220px]" />
          </div>
        </CardContent>
      </Card>

      {/* Master database */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-700"><Database size={16} className="text-white" /></div>
          <div><CardTitle className="text-base">Master contact database</CardTitle><p className="text-xs text-muted-foreground">Every sourced + enriched + verified contact is a durable, resellable asset; it decays, so it needs cheap maintenance.</p></div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
            <div><p className="text-sm font-medium">Store contacts to master DB</p><p className="text-xs text-muted-foreground">With provenance + acquisition date per row.</p></div>
            <Badge className="badge-green">Always on</Badge>
          </div>
          <div className="space-y-1">
            <Label className="text-sm font-medium">Background re-verify cadence (days)</Label>
            <Input type="number" value={cfgNum("master_reverify_cadence_days")} onChange={(e) => setCfg("master_reverify_cadence_days", e.target.value)} placeholder="30" className="max-w-[220px]" />
          </div>
        </CardContent>
      </Card>

      {/* Self-serve buyers */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600"><RefreshCw size={16} className="text-white" /></div>
          <div><CardTitle className="text-base">Self-serve buyers</CardTitle><p className="text-xs text-muted-foreground">Buyers create a quick account with their own token balance, separate from the client portal.</p></div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { t: "Quick signup (separate from client portal)", live: true },
              { t: "Own token-balance dashboard", live: true },
              { t: "Stripe token-pack purchase + top-up", live: true },
              { t: "Low-balance alert email", live: false },
            ].map((item) => (
              <div key={item.t} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2.5">
                <span className="text-sm">{item.t}</span>
                <Badge className={item.live ? "badge-green ml-auto" : "badge-slate ml-auto"}>{item.live ? "Live" : "Planned"}</Badge>
              </div>
            ))}
          </div>
          <div className="space-y-1 border-t border-border/50 pt-4">
            <Label className="text-sm font-medium">Low-balance alert threshold (tokens)</Label>
            <Input type="number" value={cfgNum("low_balance_threshold_tokens")} onChange={(e) => setCfg("low_balance_threshold_tokens", e.target.value)} placeholder="200" className="max-w-[220px]" />
            <p className="text-[11px] text-muted-foreground">Saved now so it&apos;s ready. The alert email itself is not wired yet (Planned above): this only captures the threshold.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
