"use client";

// Buyer portal home (Phase 1 shell). The token wallet balance + buy-tokens flow
// land in Phase 2 and the sourcing search in Phase 3; for now this is the
// signed-in landing surface that proves the buyer role + portal routing work.

import { PageHeader } from "@/components/layout/page-header";
import { useBuyerData } from "./buyer-data-context";
import { Coins, Search, Sparkles } from "lucide-react";

export default function BuyerDashboardPage() {
  const { fullName, email, loading } = useBuyerData();
  const greetingName = fullName?.trim() || email || "there";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Dashboard" />

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">
          {loading ? "Loading your account…" : `Welcome, ${greetingName}.`}
        </p>
        <p className="mt-1 text-base text-foreground">
          Your self-serve contact-sourcing workspace is ready. Buy tokens, run Maps and
          LinkedIn searches, and you are only charged for the contacts we actually deliver.
        </p>
      </div>

      {/* Token balance — wallet arrives in Phase 2, shown here as the anchor tile. */}
      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Coins size={20} />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Token balance
            </p>
            <p className="text-2xl font-bold tracking-tight text-foreground">0</p>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Your prepaid token wallet and one-time top-up packs are on the way. Tokens are
          spent only on delivered contacts, never on failed lookups.
        </p>
      </div>

      {/* Next-phase surfaces, shown as clearly-not-yet-available tiles. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Sparkles size={18} />
          </span>
          <p className="mt-3 text-sm font-semibold text-foreground">Buy tokens</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Secure Stripe checkout for one-time token packs. Coming next.
          </p>
        </div>
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Search size={18} />
          </span>
          <p className="mt-3 text-sm font-semibold text-foreground">Run a search</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Source businesses on Google Maps and LinkedIn, enriched and verified. Coming soon.
          </p>
        </div>
      </div>
    </div>
  );
}
