"use client";

// Buyer portal home. Shows the real token balance (from the token_balances view)
// and the purchasable pack menu (data-driven from token_packs — a pack appears
// only once it's active + priced). Buying opens a hosted Stripe Checkout. The
// sourcing search itself lands in Phase 3.

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { useBuyerData } from "./buyer-data-context";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import Link from "next/link";
import { Coins, Sparkles, Loader2, Receipt, ArrowRight } from "lucide-react";

interface Pack {
  id: string;
  name: string;
  tokens: number;
  price_usd: number;
  sort: number;
}

interface UsageEntry {
  id: string;
  entry_type: "credit" | "charge";
  tokens: number;
  search_kind: "maps" | "linkedin" | null;
  search_id: string | null;
  created_at: string;
}

export default function BuyerDashboardPage() {
  const { fullName, email, balance, loading } = useBuyerData();
  const greetingName = fullName?.trim() || email || "there";
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [usage, setUsage] = useState<UsageEntry[] | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("token_packs")
      .select("id, name, tokens, price_usd, sort")
      .order("sort")
      .then(({ data }) => {
        setPacks((data as Pack[]) ?? []);
        const purchase = new URLSearchParams(window.location.search).get("purchase");
        if (purchase === "success") setNotice("Payment received. Your tokens will appear here in a moment.");
        else if (purchase === "cancelled") setNotice("Checkout cancelled — no charge was made.");
        else if (purchase === "demo") setNotice("Checkout isn't live yet (demo mode).");
      });
    fetch(appUrl("/api/buyer/usage"))
      .then((r) => r.json().catch(() => ({})))
      .then((d: { entries?: UsageEntry[] }) => setUsage(d.entries ?? []))
      .catch(() => setUsage([]));
  }, []);

  async function buy(packId: string) {
    setNotice(null);
    setBuyingId(packId);
    try {
      const res = await fetch(appUrl("/api/billing/tokens/checkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack_id: packId }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      setNotice(data.error || "Could not start checkout.");
    } catch {
      setNotice("Network error. Please try again.");
    }
    setBuyingId(null);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Dashboard" />

      {notice && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
          {notice}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">
          {loading ? "Loading your account…" : `Welcome, ${greetingName}.`}
        </p>
        <p className="mt-1 text-base text-foreground">
          Your self-serve contact-sourcing workspace. Buy tokens, run Maps and LinkedIn
          searches, and you are only charged for the contacts we actually deliver.
        </p>
      </div>

      {/* Token balance from the ledger view. */}
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Coins size={20} />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Token balance
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {loading ? "—" : balance.available.toLocaleString()}
            </p>
          </div>
          {balance.held > 0 && (
            <div className="ml-auto text-right">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">On hold</p>
              <p className="text-lg font-semibold text-foreground">{balance.held.toLocaleString()}</p>
            </div>
          )}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Tokens are spent only on delivered contacts, never on failed lookups. Held tokens are
          reserved against a running search and released if unused.
        </p>
      </div>

      {/* Buy tokens — data-driven from token_packs (active + priced only). */}
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 pb-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={18} />
          </span>
          <p className="text-sm font-semibold text-foreground">Buy tokens</p>
        </div>
        {packs === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading packs…</p>
        ) : packs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Token packs are coming soon. Check back shortly.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {packs.map((pack) => (
              <div key={pack.id} className="flex flex-col rounded-xl border border-border p-4">
                <p className="text-sm font-semibold text-foreground">{pack.name}</p>
                <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">
                  {pack.tokens.toLocaleString()}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">tokens</span>
                </p>
                <p className="mt-1 text-sm text-muted-foreground">${pack.price_usd.toLocaleString()}</p>
                <button
                  onClick={() => buy(pack.id)}
                  disabled={buyingId !== null}
                  className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {buyingId === pack.id ? <Loader2 size={16} className="animate-spin" /> : "Buy"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent activity — token consumption history (purchases + spends). */}
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 pb-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Receipt size={18} />
          </span>
          <p className="text-sm font-semibold text-foreground">Recent activity</p>
        </div>
        {usage === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        ) : usage.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No activity yet. Buy tokens and run a search to get started.
          </p>
        ) : (
          <div className="mt-2 divide-y divide-border/60">
            {usage.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p className="font-medium text-foreground">
                    {e.entry_type === "credit" ? "Tokens purchased" : `Contacts sourced${e.search_kind ? ` · ${e.search_kind}` : ""}`}
                  </p>
                  <p className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</p>
                </div>
                <span className={`font-semibold ${e.entry_type === "credit" ? "text-green-600" : "text-foreground"}`}>
                  {e.entry_type === "credit" ? "+" : "-"}{e.tokens.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Run a search — live (Phase 5). */}
      <Link href="/buyer/search" className="flex items-center gap-3 rounded-2xl border border-border bg-white p-6 shadow-sm transition-colors hover:bg-muted/30">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles size={18} />
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">Run a search</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Source businesses on Google Maps and LinkedIn, enriched and verified.
          </p>
        </div>
        <ArrowRight size={18} className="text-muted-foreground" />
      </Link>
    </div>
  );
}
