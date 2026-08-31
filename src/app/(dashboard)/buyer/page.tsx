"use client";

// Buyer portal home. Thin wrapper: fetch live data (packs, usage), then render the
// shared <BuyerDashboardView> fed by the admin-edited content from the buyer data
// context. The admin "Buyer experience" preview renders the SAME component, so the
// two never drift.

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { useBuyerData } from "./buyer-data-context";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import { BuyerDashboardView, type DashPack, type DashUsage } from "@/components/buyer/buyer-dashboard-view";

export default function BuyerDashboardPage() {
  const { fullName, email, balance, loading, experience } = useBuyerData();
  const greetingName = fullName?.trim() || email || "there";
  const [packs, setPacks] = useState<DashPack[] | null>(null);
  const [usage, setUsage] = useState<DashUsage[] | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("token_packs")
      .select("id, name, tokens, price_usd, sort")
      .order("sort")
      .then(({ data }) => {
        setPacks((data as DashPack[]) ?? []);
        const purchase = new URLSearchParams(window.location.search).get("purchase");
        if (purchase === "success") setNotice("Payment received. Your tokens will appear here in a moment.");
        else if (purchase === "cancelled") setNotice("Checkout cancelled. No charge was made.");
        else if (purchase === "demo") setNotice("Checkout isn't live yet (demo mode).");
      });
    fetch(appUrl("/api/buyer/usage"))
      .then((r) => r.json().catch(() => ({})))
      .then((d: { entries?: DashUsage[] }) => setUsage(d.entries ?? []))
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
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">{notice}</div>
      )}
      <BuyerDashboardView
        content={experience}
        greetingName={greetingName}
        balance={balance}
        loadingBalance={loading}
        packs={packs}
        usage={usage}
        buyingId={buyingId}
        onBuy={buy}
      />
    </div>
  );
}
