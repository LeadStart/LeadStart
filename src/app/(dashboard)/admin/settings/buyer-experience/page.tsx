"use client";

// Admin "Buyer experience" editor. Edit the buyer-portal copy/presentation on the
// left; the right pane is a LIVE PREVIEW rendering the real <BuyerDashboardView>
// with your draft content, so what you see is exactly what buyers get. Save writes
// the single buyer_experience_config the real buyer pages read: one edit, in sync
// everywhere.

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { appUrl } from "@/lib/api-url";
import { Save, Loader2, Info } from "lucide-react";
import { BuyerDashboardView, type DashPack, type DashUsage } from "@/components/buyer/buyer-dashboard-view";
import { DEFAULT_BUYER_EXPERIENCE, mergeBuyerExperience, type BuyerExperience, type AnnouncementVariant } from "@/lib/buyer-experience/content";

const SAMPLE_PACKS: DashPack[] = [
  { id: "s", name: "Starter", tokens: 1000, price_usd: 49 },
  { id: "g", name: "Growth", tokens: 5000, price_usd: 199 },
  { id: "c", name: "Scale", tokens: 25000, price_usd: 799 },
];
const SAMPLE_USAGE: DashUsage[] = [
  { id: "1", entry_type: "credit", tokens: 5000, search_kind: null, notes: null, created_at: new Date(2026, 7, 30, 10, 12).toISOString() },
  { id: "2", entry_type: "charge", tokens: 12, search_kind: "maps", notes: null, created_at: new Date(2026, 7, 30, 11, 3).toISOString() },
  { id: "3", entry_type: "charge", tokens: 8, search_kind: null, notes: "reverify", created_at: new Date(2026, 7, 31, 9, 41).toISOString() },
];

function Field({ label, value, onChange, textarea, placeholder }: { label: string; value: string; onChange: (v: string) => void; textarea?: boolean; placeholder?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      )}
    </label>
  );
}

export default function BuyerExperiencePage() {
  const [draft, setDraft] = useState<BuyerExperience>(DEFAULT_BUYER_EXPERIENCE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(appUrl("/api/admin/buyer-experience"))
      .then((r) => r.json().catch(() => ({})))
      .then((d: { experience?: unknown }) => setDraft(mergeBuyerExperience(d.experience)))
      .catch(() => setDraft(DEFAULT_BUYER_EXPERIENCE))
      .finally(() => setLoading(false));
  }, []);

  const patchAnn = useCallback((p: Partial<BuyerExperience["announcement"]>) => { setDraft((d) => ({ ...d, announcement: { ...d.announcement, ...p } })); setSaved(false); }, []);
  const patchDash = useCallback((p: Partial<BuyerExperience["dashboard"]>) => { setDraft((d) => ({ ...d, dashboard: { ...d.dashboard, ...p } })); setSaved(false); }, []);
  const patchEmpty = useCallback((p: Partial<BuyerExperience["empty"]>) => { setDraft((d) => ({ ...d, empty: { ...d.empty, ...p } })); setSaved(false); }, []);
  const patchTips = useCallback((p: Partial<BuyerExperience["tips"]>) => { setDraft((d) => ({ ...d, tips: { ...d.tips, ...p } })); setSaved(false); }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(appUrl("/api/admin/buyer-experience"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experience: draft }),
      });
      if (res.ok) setSaved(true);
      else setError((await res.json().catch(() => ({})))?.error || "Save failed.");
    } catch {
      setError("Network error.");
    }
    setSaving(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>Edit the buyer portal&rsquo;s copy here. The preview on the right renders the real buyer dashboard, so it is exactly what buyers see once you save.</span>
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

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor */}
        <div className="space-y-5">
          <section className="rounded-2xl border border-border bg-white p-5 shadow-sm space-y-3">
            <p className="text-sm font-semibold text-foreground">Announcement banner</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.announcement.enabled} onChange={(e) => patchAnn({ enabled: e.target.checked })} /> Show a banner at the top of the buyer portal
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">Style</span>
              <select value={draft.announcement.variant} onChange={(e) => patchAnn({ variant: e.target.value as AnnouncementVariant })} className="w-full rounded-lg border border-border px-3 py-2 text-sm">
                <option value="info">Info (blue)</option>
                <option value="warning">Warning (amber)</option>
                <option value="success">Success (green)</option>
              </select>
            </label>
            <Field label="Banner text" value={draft.announcement.text} onChange={(v) => patchAnn({ text: v })} textarea placeholder="e.g. Scheduled maintenance Sunday 9pm ET." />
          </section>

          <section className="rounded-2xl border border-border bg-white p-5 shadow-sm space-y-3">
            <p className="text-sm font-semibold text-foreground">Dashboard copy</p>
            <Field label="Welcome paragraph" value={draft.dashboard.welcome_body} onChange={(v) => patchDash({ welcome_body: v })} textarea />
            <Field label="Balance note" value={draft.dashboard.balance_note} onChange={(v) => patchDash({ balance_note: v })} textarea />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Packs heading" value={draft.dashboard.packs_heading} onChange={(v) => patchDash({ packs_heading: v })} />
              <Field label="Packs note" value={draft.dashboard.packs_note} onChange={(v) => patchDash({ packs_note: v })} />
            </div>
            <Field label="Activity heading" value={draft.dashboard.activity_heading} onChange={(v) => patchDash({ activity_heading: v })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Search CTA title" value={draft.dashboard.search_cta_title} onChange={(v) => patchDash({ search_cta_title: v })} />
              <Field label="Search CTA body" value={draft.dashboard.search_cta_body} onChange={(v) => patchDash({ search_cta_body: v })} />
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-white p-5 shadow-sm space-y-3">
            <p className="text-sm font-semibold text-foreground">Empty states &amp; tips</p>
            <Field label="No contacts yet" value={draft.empty.contacts} onChange={(v) => patchEmpty({ contacts: v })} />
            <Field label="No searches yet" value={draft.empty.searches} onChange={(v) => patchEmpty({ searches: v })} />
            <Field label="Search form tip (optional)" value={draft.tips.search} onChange={(v) => patchTips({ search: v })} placeholder="e.g. Comma-separate multiple business types." />
          </section>
        </div>

        {/* Live preview: the real buyer dashboard */}
        <div className="lg:sticky lg:top-6 self-start">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live preview: the buyer dashboard</p>
          <div className="rounded-2xl border border-border bg-[#F4F5F9] p-4">
            <BuyerDashboardView
              content={draft}
              greetingName="Alex"
              balance={{ available: 1250, held: 200 }}
              packs={SAMPLE_PACKS}
              usage={SAMPLE_USAGE}
              preview
            />
          </div>
        </div>
      </div>
    </div>
  );
}
