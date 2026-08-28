"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShoppingCart, Loader2, CheckCircle, AlertTriangle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

type RegistrarId = "porkbun" | "spaceship";

interface Quote {
  registrar: RegistrarId;
  available: boolean;
  price_usd: number | null;
}
interface QuoteResult {
  domain: string;
  quotes: Quote[];
  errors: string[];
  spend: { month_to_date_usd: number; cap_usd: number | null; remaining_usd: number | null };
}

const REGISTRARS: { id: RegistrarId; label: string }[] = [
  { id: "porkbun", label: "Porkbun" },
  { id: "spaceship", label: "Spaceship" },
];

function usd(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

export function ProvisionDomainPanel({ onChange }: { onChange: () => void }) {
  const [domain, setDomain] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [selected, setSelected] = useState<RegistrarId | null>(null);
  const [buying, setBuying] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [trackDomain, setTrackDomain] = useState("");
  const [trackRegistrar, setTrackRegistrar] = useState<"manual" | "porkbun" | "spaceship">("manual");
  const [tracking, setTracking] = useState(false);

  // Cheapest available registrar → the pre-selected "best price".
  const available = (quote?.quotes ?? []).filter((q) => q.available);
  const best = available
    .slice()
    .sort((a, b) => (a.price_usd ?? Infinity) - (b.price_usd ?? Infinity))[0];

  async function runQuote() {
    const d = domain.trim().toLowerCase();
    if (!d) return;
    setQuoting(true);
    setBanner(null);
    setQuote(null);
    setSelected(null);
    try {
      const res = await fetch(appUrl("/api/admin/registrar/quote"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ kind: "err", text: data.error ?? "Could not price that domain." });
        return;
      }
      setQuote(data as QuoteResult);
      const cheapest = (data.quotes as Quote[])
        .filter((q) => q.available)
        .sort((a, b) => (a.price_usd ?? Infinity) - (b.price_usd ?? Infinity))[0];
      setSelected(cheapest?.registrar ?? null);
    } catch (err) {
      setBanner({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setQuoting(false);
    }
  }

  async function buy() {
    if (!quote || !selected) return;
    setBuying(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/registrar/provision"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: quote.domain, registrar: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ kind: "err", text: data.error ?? "Purchase failed." });
        return;
      }
      setBanner({
        kind: "ok",
        text: data.dns_written
          ? `Bought ${quote.domain} at ${data.registrar} for ${usd(data.price_usd)}. DNS written — set up its inboxes below.`
          : `Bought ${quote.domain} at ${data.registrar}, but writing DNS failed (${data.dns_error ?? "unknown"}). Use "Retry DNS" in its row below.`,
      });
      setQuote(null);
      setDomain("");
      onChange();
    } catch (err) {
      setBanner({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBuying(false);
    }
  }

  async function track() {
    const d = trackDomain.trim().toLowerCase();
    if (!d) return;
    setTracking(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/domains"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d, registrar: trackRegistrar }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ kind: "err", text: data.error ?? "Could not track that domain." });
        return;
      }
      setBanner({ kind: "ok", text: `Now tracking ${d}. Set up its inboxes in its row below.` });
      setTrackDomain("");
      onChange();
    } catch (err) {
      setBanner({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTracking(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
          <ShoppingCart size={16} className="text-white" />
        </div>
        <div>
          <CardTitle className="text-base">Provision a domain</CardTitle>
          <p className="text-xs text-muted-foreground">
            Buy a fresh sending domain and lay down its DNS, or track one you already own.
            After it&rsquo;s in, set up its Google Workspace inboxes from its row below.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {banner && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${
              banner.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {banner.kind === "ok" ? (
              <CheckCircle size={14} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            )}
            <span>{banner.text}</span>
          </div>
        )}

        {/* Buy a new domain */}
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="prov-domain" className="text-xs">
                Buy a new domain
              </Label>
              <Input
                id="prov-domain"
                placeholder="tryacme.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runQuote()}
              />
            </div>
            <Button variant="outline" onClick={runQuote} disabled={quoting || !domain.trim()}>
              {quoting ? <Loader2 size={14} className="animate-spin" /> : "Check price"}
            </Button>
          </div>

          {quote && (
            <div className="space-y-3">
              {/* Split registrar selector */}
              <div className="grid grid-cols-2 gap-2">
                {REGISTRARS.map((r) => {
                  const q = quote.quotes.find((x) => x.registrar === r.id);
                  const err = quote.errors.find((e) => e.startsWith(`${r.id}:`));
                  const selectable = !!q?.available;
                  const isBest = best?.registrar === r.id;
                  const isSelected = selected === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={!selectable}
                      onClick={() => selectable && setSelected(r.id)}
                      className={`rounded-xl border p-3 text-left transition ${
                        isSelected
                          ? "border-indigo-500 ring-2 ring-indigo-200 bg-indigo-50/50"
                          : selectable
                            ? "border-border hover:border-indigo-300 cursor-pointer"
                            : "border-border/50 bg-muted/30 opacity-60 cursor-not-allowed"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">{r.label}</span>
                        {isBest && selectable && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            Best price
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-lg font-bold tabular-nums">
                        {selectable ? usd(q?.price_usd) : "—"}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {selectable
                          ? q?.price_usd == null
                            ? "available · price unknown"
                            : "available · first year"
                          : err
                            ? "unavailable"
                            : "not configured"}
                      </div>
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-muted-foreground">
                Google bills roughly $7&ndash;8.40/mo per inbox seat, so 3 inboxes is about
                $21&ndash;25/mo on top of the domain price.
                {quote.spend.cap_usd != null && (
                  <>
                    {" "}Spend this month: {usd(quote.spend.month_to_date_usd)} of{" "}
                    {usd(quote.spend.cap_usd)} ({usd(quote.spend.remaining_usd)} left).
                  </>
                )}
              </p>

              <Button onClick={buy} disabled={buying || !selected} className="w-full">
                {buying ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : selected ? (
                  `Buy ${quote.domain} at ${REGISTRARS.find((r) => r.id === selected)?.label}`
                ) : (
                  "Pick a registrar"
                )}
              </Button>
            </div>
          )}
        </div>

        {/* Track an existing domain */}
        <div className="space-y-2 border-t border-border/50 pt-3">
          <Label htmlFor="track-domain" className="text-xs">
            Or track a domain you already own
          </Label>
          <div className="flex items-end gap-2">
            <Input
              id="track-domain"
              placeholder="mail.acme.com"
              value={trackDomain}
              onChange={(e) => setTrackDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && track()}
              className="flex-1"
            />
            <select
              value={trackRegistrar}
              onChange={(e) => setTrackRegistrar(e.target.value as "manual" | "porkbun" | "spaceship")}
              className="h-9 rounded-md border border-input bg-background px-2 text-xs"
              aria-label="Where this domain's DNS lives"
            >
              <option value="manual">DNS: Manual</option>
              <option value="porkbun">DNS: Porkbun</option>
              <option value="spaceship">DNS: Spaceship</option>
            </select>
            <Button variant="outline" onClick={track} disabled={tracking || !trackDomain.trim()}>
              {tracking ? <Loader2 size={14} className="animate-spin" /> : "Track"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            No purchase. Pick where the domain&rsquo;s DNS lives: a connected registrar lets LeadStart write
            its DNS automatically; Manual means you add the records by hand.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
