"use client";

// The buyer dashboard, as a PURE presentational component: content + data in, JSX
// out, no fetching. The real /buyer page renders it fed by live data + the saved
// content; the admin "Buyer experience" preview renders the SAME component fed by
// sample data + the draft content. That shared rendering is what keeps the admin
// editor and what buyers see visually in lock-step.

import Link from "next/link";
import { Coins, Sparkles, Loader2, Receipt, ArrowRight, Info, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { BuyerExperience, AnnouncementVariant } from "@/lib/buyer-experience/content";

export interface DashPack {
  id: string;
  name: string;
  tokens: number;
  price_usd: number;
}
export interface DashUsage {
  id: string;
  entry_type: "credit" | "charge";
  tokens: number;
  search_kind: "maps" | "linkedin" | null;
  notes: string | null;
  created_at: string;
}

function usageLabel(e: DashUsage): string {
  if (e.entry_type === "credit") return "Tokens purchased";
  if (e.notes === "reverify") return "Emails re-verified";
  return `Contacts sourced${e.search_kind ? ` · ${e.search_kind}` : ""}`;
}

const ANNOUNCE_STYLE: Record<AnnouncementVariant, { box: string; icon: React.ReactNode }> = {
  info: { box: "border-primary/20 bg-primary/5 text-foreground", icon: <Info size={16} className="mt-0.5 shrink-0 text-primary" /> },
  warning: { box: "border-amber-300 bg-amber-50 text-amber-900", icon: <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" /> },
  success: { box: "border-green-300 bg-green-50 text-green-900", icon: <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-600" /> },
};

// The buyer-portal announcement banner. Shared by the dashboard, the other buyer
// pages, and the admin preview so one edit shows everywhere. Renders nothing when
// disabled or empty.
export function BuyerAnnouncement({ announcement }: { announcement: BuyerExperience["announcement"] }) {
  if (!announcement.enabled || !announcement.text.trim()) return null;
  const s = ANNOUNCE_STYLE[announcement.variant] ?? ANNOUNCE_STYLE.info;
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${s.box}`}>
      {s.icon}
      <span>{announcement.text}</span>
    </div>
  );
}

export interface BuyerDashboardViewProps {
  content: BuyerExperience;
  greetingName: string;
  balance: { available: number; held: number };
  loadingBalance?: boolean;
  packs: DashPack[] | null;
  usage: DashUsage[] | null;
  buyingId?: string | null;
  onBuy?: (packId: string) => void;
  searchHref?: string;
  preview?: boolean;
}

export function BuyerDashboardView({
  content,
  greetingName,
  balance,
  loadingBalance,
  packs,
  usage,
  buyingId,
  onBuy,
  searchHref = "/buyer/search",
  preview,
}: BuyerDashboardViewProps) {
  return (
    <div className="space-y-6">
      <BuyerAnnouncement announcement={content.announcement} />

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">
          {loadingBalance ? "Loading your account…" : `Welcome, ${greetingName}.`}
        </p>
        <p className="mt-1 text-base text-foreground">{content.dashboard.welcome_body}</p>
      </div>

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Coins size={20} />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Token balance</p>
            <p className="text-2xl font-bold tracking-tight text-foreground">
              {loadingBalance ? "—" : balance.available.toLocaleString()}
            </p>
          </div>
          {balance.held > 0 && (
            <div className="ml-auto text-right">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">On hold</p>
              <p className="text-lg font-semibold text-foreground">{balance.held.toLocaleString()}</p>
            </div>
          )}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{content.dashboard.balance_note}</p>
      </div>

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 pb-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={18} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{content.dashboard.packs_heading}</p>
            {content.dashboard.packs_note.trim() && (
              <p className="text-xs text-muted-foreground">{content.dashboard.packs_note}</p>
            )}
          </div>
        </div>
        {packs === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading packs…</p>
        ) : packs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Token packs are coming soon. Check back shortly.</p>
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
                  onClick={() => onBuy?.(pack.id)}
                  disabled={preview || buyingId !== null}
                  className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {buyingId === pack.id ? <Loader2 size={16} className="animate-spin" /> : "Buy"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 pb-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Receipt size={18} />
          </span>
          <p className="text-sm font-semibold text-foreground">{content.dashboard.activity_heading}</p>
        </div>
        {usage === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        ) : usage.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No activity yet. Buy tokens and run a search to get started.</p>
        ) : (
          <div className="mt-2 divide-y divide-border/60">
            {usage.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p className="font-medium text-foreground">{usageLabel(e)}</p>
                  <p className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</p>
                </div>
                <span className={`font-semibold ${e.entry_type === "credit" ? "text-green-600" : "text-foreground"}`}>
                  {e.entry_type === "credit" ? "+" : "-"}
                  {e.tokens.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Link
        href={preview ? "#" : searchHref}
        onClick={preview ? (ev) => ev.preventDefault() : undefined}
        className="flex items-center gap-3 rounded-2xl border border-border bg-white p-6 shadow-sm transition-colors hover:bg-muted/30"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles size={18} />
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">{content.dashboard.search_cta_title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{content.dashboard.search_cta_body}</p>
        </div>
        <ArrowRight size={18} className="text-muted-foreground" />
      </Link>
    </div>
  );
}
