"use client";
import { PageHeader } from "@/components/layout/page-header";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { ADMIN_CONTACTS_KEY, fetchAdminContacts } from "@/lib/admin-queries";
import { classifyEmailTier, emailTierRank } from "@/lib/enrichment/email-tier";
import { useSort } from "@/hooks/use-sort";
import { useUser } from "@/hooks/use-user";
import { SortableHead } from "@/components/ui/sortable-head";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { verificationBadge } from "@/lib/millionverifier/labels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatCard } from "@/components/charts/stat-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import {
  PROFILE_EMAIL_COST_USD,
  DOMAIN_COST_USD,
  ACTIVITY_COST_USD,
  MV_CREDIT_COST_USD,
  DOMAIN_DISCOVERY_COST_USD,
  estimateBoviCost,
  estimatePatternMvCost,
  estimateScrapeCost,
} from "@/lib/apify/pricing";
import { toast } from "sonner";
import Link from "next/link";
import {
  Users,
  Plus,
  CheckCircle,
  Upload,
  AlertCircle,
  TrendingUp,
  ChevronDown,
  Trash2,
  Send,
  Sparkles,
} from "lucide-react";
import type { Contact, ContactStatus, ProspectStage } from "@/types/app";
import { ImportContactsDialog } from "./import-dialog";
import {
  EnrichmentRunBanner,
  fetchActiveEnrichmentRunId,
} from "@/components/contacts/enrichment-run-banner";

const CONTACTS_PAGE_SIZE = 25;

// Enrich cost estimate (per contact/step). The waterfall estimate depends on the
// configured method (pattern / scrape / bovi) — see the pricing helpers.
const ENRICH_COST_PROFILE = PROFILE_EMAIL_COST_USD;
const ENRICH_COST_DOMAIN = DOMAIN_COST_USD;
const ENRICH_COST_ACTIVITY = ACTIVITY_COST_USD;
const ENRICH_COST_VERIFY = MV_CREDIT_COST_USD;
const ENRICH_COST_DISCOVERY = DOMAIN_DISCOVERY_COST_USD;

// Relative "time ago" for the Last posted column.
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Lucide dropped its brand-icon set upstream, so inline the LinkedIn glyph
// (same SVG used in the client-page LinkedIn section).
function LinkedinIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
    </svg>
  );
}

const PIPELINE_STAGES: { value: ProspectStage; label: string }[] = [
  { value: "lead", label: "Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "meeting", label: "Meeting" },
  { value: "proposal", label: "Proposal" },
  { value: "closed", label: "Closed Won" },
  { value: "lost", label: "Lost" },
];

function pipelineStageLabel(s: ProspectStage): string {
  return PIPELINE_STAGES.find((p) => p.value === s)?.label ?? s;
}

// Tags cell that keeps rows at a single-row height by default and reveals
// the full list on click. Chevron only appears when tags actually overflow.
function TagsCell({ tags }: { tags: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const first = el.firstElementChild as HTMLElement | null;
      const last = el.lastElementChild as HTMLElement | null;
      if (!first || !last || first === last) {
        setOverflowing(false);
        return;
      }
      setOverflowing(last.offsetTop > first.offsetTop);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags]);

  if (!tags || tags.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex items-start gap-1.5">
      <div
        ref={ref}
        className={`flex flex-wrap gap-1 flex-1 ${
          expanded ? "" : "max-h-[26px] overflow-hidden"
        }`}
      >
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="badge-green">
            {tag}
          </Badge>
        ))}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-label={expanded ? "Collapse tags" : "Expand tags"}
          className="shrink-0 flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground cursor-pointer transition-colors"
        >
          <ChevronDown
            size={14}
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      )}
    </div>
  );
}

// Visible statuses — user-selectable in filter + form.
// Note: "unsubscribed" remains in the DB enum (set by webhooks) but isn't
// a manually-selectable state in the UI.
const VISIBLE_STATUSES: ContactStatus[] = [
  "new",
  "enriched",
  "uploaded",
  "active",
  "bounced",
  "replied",
];

function statusLabel(s: ContactStatus) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- Email verification status: list filter (Million Verifier vocab) ----
// The per-row badge is rendered inline with verificationBadge() from
// @/lib/millionverifier/labels — the single source of truth for status
// presentation. This filter narrows the list by that same MV status.
type EmailStatusFilter = "all" | "verified" | "needs_enrichment" | "risky" | "invalid";
const EMAIL_STATUS_FILTER_OPTIONS: { value: EmailStatusFilter; label: string }[] = [
  { value: "all", label: "All Email Statuses" },
  { value: "verified", label: "Verified" },
  { value: "needs_enrichment", label: "Needs enrichment" },
  { value: "risky", label: "Risky / catch-all" },
  { value: "invalid", label: "Invalid / disposable" },
];
function matchesEmailStatusFilter(c: Contact, f: EmailStatusFilter): boolean {
  const s = c.email_verification_status;
  switch (f) {
    case "verified":
      return s === "ok";
    case "needs_enrichment":
      return !c.email;
    case "risky":
      return s === "catch_all" || s === "unknown";
    case "invalid":
      return s === "invalid" || s === "disposable";
    default:
      return true;
  }
}

type OwnerView = "leadstart" | "client";

type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  title: string;
  phone: string;
  linkedin: string;
  tags: string;
  notes: string;
  pipelineStage: ProspectStage | "none";
  clientId: string;
  owner: OwnerView;
};

const EMPTY_FORM: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  company: "",
  title: "",
  phone: "",
  linkedin: "",
  tags: "",
  notes: "",
  pipelineStage: "none",
  clientId: "",
  owner: "leadstart",
};

function contactToForm(c: Contact): FormState {
  return {
    firstName: c.first_name ?? "",
    lastName: c.last_name ?? "",
    email: c.email ?? "",
    company: c.company_name ?? "",
    title: c.title ?? "",
    phone: c.phone ?? "",
    linkedin: c.linkedin_url ?? "",
    tags: (c.tags ?? []).join(", "),
    notes: c.notes ?? "",
    pipelineStage: c.pipeline_stage ?? "none",
    clientId: c.client_id ?? "",
    owner: c.client_id ? "client" : "leadstart",
  };
}

export default function ContactsPage() {
  const { organizationId } = useUser();
  const { mutate: swrMutate } = useSWRConfig();
  const searchParams = useSearchParams();
  const [ownerView, setOwnerView] = useState<OwnerView>("leadstart");
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");

  // Sync search input when arriving via topbar global search (?q=...).
  useEffect(() => {
    const q = searchParams.get("q");
    if (q !== null) setSearch(q);
  }, [searchParams]);
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("all");
  const [emailStatusFilter, setEmailStatusFilter] = useState<EmailStatusFilter>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");

  // Unified dialog state — null = closed, "add" = new, Contact = edit
  const [dialogMode, setDialogMode] = useState<"add" | Contact | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data, loading, refetch } = useSupabaseQuery(
    ADMIN_CONTACTS_KEY,
    fetchAdminContacts,
  );

  const allContacts = data?.contacts ?? [];
  const clients = data?.clients ?? [];
  const campaigns = data?.campaigns ?? [];
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));
  const campaignMap = new Map(campaigns.map((c) => [c.id, c.name]));

  // Split by owner. LeadStart contacts (client_id IS NULL) are the agency's
  // own prospects — they're the only ones eligible for the Prospects kanban.
  // Client contacts belong to a client's campaign recipient list.
  const contacts = allContacts.filter((c) =>
    ownerView === "leadstart" ? c.client_id === null : c.client_id !== null,
  );

  const totalContacts = contacts.length;
  const enrichedCount = contacts.filter((c) => c.status === "enriched").length;
  const uploadedCount = contacts.filter((c) => c.status === "uploaded").length;
  const needsEnrichment = contacts.filter((c) => c.status === "new").length;

  const filtered = contacts.filter((c) => {
    const matchesSearch =
      !search ||
      (c.first_name || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.last_name || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.email || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.company_name || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.company_domain || "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    const matchesEmailStatus = matchesEmailStatusFilter(c, emailStatusFilter);
    const matchesClient =
      ownerView === "leadstart" || clientFilter === "all" || c.client_id === clientFilter;
    return matchesSearch && matchesStatus && matchesEmailStatus && matchesClient;
  });

  const rows = filtered.map((contact) => ({
    ...contact,
    fullName: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "—",
    clientName: contact.client_id ? clientMap.get(contact.client_id) || "—" : "—",
    email_tier: classifyEmailTier(contact),
    email_tier_rank: emailTierRank(contact),
  }));
  // Default order = found-first email tiers (person → company inbox → catch-all
  // → none; owner ruling 2026-08-26). Stable sort keeps newest-first within a
  // tier (rows arrive created_at desc); any column click still re-sorts.
  const { sorted, sortConfig, requestSort } = useSort(rows, "email_tier_rank", "asc");

  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, emailStatusFilter, clientFilter, ownerView, sortConfig?.key, sortConfig?.direction]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / CONTACTS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * CONTACTS_PAGE_SIZE;
  const pageRows = sorted.slice(pageStart, pageStart + CONTACTS_PAGE_SIZE);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [campaignDialogOpen, setCampaignDialogOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [enrichDialogOpen, setEnrichDialogOpen] = useState(false);
  const [enrichRunProfiles, setEnrichRunProfiles] = useState(true);
  const [enrichRunDomains, setEnrichRunDomains] = useState(true);
  const [enrichRunWaterfall, setEnrichRunWaterfall] = useState(true);
  // Activity + verify are opt-in add-ons (default OFF), matching Prospecting.
  const [enrichRunActivity, setEnrichRunActivity] = useState(false);
  const [enrichRunVerify, setEnrichRunVerify] = useState(false);
  const [enrichRunNaming, setEnrichRunNaming] = useState(false);
  const [enrichIncludeCatchAll, setEnrichIncludeCatchAll] = useState(false);
  const [enrichValidateCatchAll, setEnrichValidateCatchAll] = useState(false);
  const [enrichStarting, setEnrichStarting] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  // Org waterfall config (migration 00075) — fetched when the dialog opens so
  // the estimate uses the real per-company lead cap and a config-disabled
  // waterfall shows as such instead of silently not running.
  const [enrichWaterfallCfg, setEnrichWaterfallCfg] = useState<{
    enabled: boolean;
    // Cost shape of the configured method(s): "pattern" (pattern_mv, ~$0.004/contact
    // via Million Verifier), "scrape" (our site scraper, per-domain compute),
    // "apify" (the bovi pattern finder, per-domain), or "off".
    kind: "off" | "pattern" | "scrape" | "apify";
    // Whether web-lookup domain discovery is on (name-only companies can gain a
    // domain, so they count toward the domain + downstream estimate).
    domainDiscovery: boolean;
  } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedIds(new Set());
    setCampaignDialogOpen(false);
  }, [ownerView]);
  // Resume the run banner after a refresh if a run is still active.
  useEffect(() => {
    let cancelled = false;
    fetchActiveEnrichmentRunId().then((id) => {
      if (!cancelled && id) setActiveRunId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Load the org's waterfall config when the enrich dialog opens (once per open).
  useEffect(() => {
    if (!enrichDialogOpen) return;
    let cancelled = false;
    fetch(appUrl("/api/admin/enrichment/settings"), { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (d: {
          settings?: {
            waterfall_enabled?: boolean;
            small_method?: string;
            large_method?: string;
            unknown_method?: string;
            domain_discovery_enabled?: boolean;
          };
        }) => {
          if (cancelled || !d?.settings) return;
          const s = d.settings;
          const enabled = s.waterfall_enabled !== false;
          const methods = [s.small_method, s.large_method, s.unknown_method];
          const applicable = methods.filter((m) => m && m !== "off");
          // Pick the estimate shape from the priciest method in play: the bovi
          // pattern finder > our site scraper > pattern+verify.
          const kind: "off" | "pattern" | "scrape" | "apify" =
            applicable.length === 0
              ? "off"
              : applicable.some((m) => m === "bovi")
                ? "apify"
                : applicable.some((m) => m === "site_scrape" || m === "scrape_plus_pattern")
                  ? "scrape"
                  : "pattern";
          setEnrichWaterfallCfg({ enabled, kind, domainDiscovery: s.domain_discovery_enabled !== false });
          if (!enabled || kind === "off") setEnrichRunWaterfall(false);
        },
      )
      .catch(() => {
        /* estimate falls back to defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [enrichDialogOpen]);

  const pageRowIds = pageRows.map((r) => r.id);
  const filteredIds = sorted.map((r) => r.id);
  const pageAllSelected =
    pageRowIds.length > 0 && pageRowIds.every((id) => selectedIds.has(id));
  const pageSomeSelected = pageRowIds.some((id) => selectedIds.has(id));
  const filteredAllSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const filteredSomeSelected = filteredIds.some((id) => selectedIds.has(id));

  function toggleRowSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePageSelection() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        pageRowIds.forEach((id) => next.delete(id));
      } else {
        pageRowIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  function toggleFilteredSelection() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filteredAllSelected) {
        filteredIds.forEach((id) => next.delete(id));
      } else {
        filteredIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (
      !confirm(
        `Delete ${count} contact${count === 1 ? "" : "s"}? This permanently removes them and cannot be undone.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    try {
      const supabase = createClient();
      const ids = Array.from(selectedIds);
      const { error } = await supabase.from("contacts").delete().in("id", ids);
      if (error) {
        alert(`Failed to delete contacts: ${error.message}`);
        return;
      }
      setSelectedIds(new Set());
      await refetch();
      await swrMutate("admin-contacts-with-pipeline");
      toast.success(`Deleted ${count} contact${count === 1 ? "" : "s"}`);
    } finally {
      setBulkDeleting(false);
    }
  }

  const selectedContacts = allContacts.filter((c) => selectedIds.has(c.id));
  const selectedClientIds = new Set(
    selectedContacts.map((c) => c.client_id).filter(Boolean) as string[],
  );
  const isMixedClients = selectedClientIds.size > 1;
  const commonClientId =
    selectedClientIds.size === 1 ? [...selectedClientIds][0] : null;
  const eligibleCampaigns = campaigns.filter(
    (c) => c.client_id === commonClientId,
  );

  // Enrich eligibility, computed from the current selection.
  const discoveryOn = enrichWaterfallCfg?.domainDiscovery ?? true;
  // Domain resolution splits two ways: a LinkedIn company page (linkedin-company
  // actor) vs a name-only company with no page (web-lookup discovery, when on).
  const enrichNeedsDomainLinkedin = selectedContacts.filter(
    (c) => c.company_linkedin_url && !c.company_domain,
  ).length;
  const enrichNeedsDomainDiscovery = discoveryOn
    ? selectedContacts.filter((c) => !c.company_linkedin_url && !c.company_domain && c.company_name).length
    : 0;
  const enrichNeedsDomain = enrichNeedsDomainLinkedin + enrichNeedsDomainDiscovery;
  const enrichNeedsEmail = selectedContacts.filter(
    (c) =>
      !c.email &&
      (c.linkedin_url || c.company_domain || c.company_linkedin_url || (discoveryOn && c.company_name)),
  ).length;
  const enrichActivityCount = selectedContacts.filter((c) => c.linkedin_url).length;
  // Verifiable emails: those already on a contact + those we expect to find.
  const enrichVerifyCount =
    selectedContacts.filter((c) => c.email).length + enrichNeedsEmail;
  // The waterfall crawls per company DOMAIN (unique known domains + contacts that
  // may still gain one), pulling up to the configured lead cap per domain — each
  // lead billed. This is the honest per-domain math; the old per-contact estimate
  // under-counted ~100× on the free tier.
  const enrichWaterfallDomains = (() => {
    const missing = selectedContacts.filter(
      (c) =>
        !c.email &&
        (c.linkedin_url || c.company_domain || c.company_linkedin_url || (discoveryOn && c.company_name)),
    );
    const domains = new Set<string>();
    let unknown = 0;
    for (const c of missing) {
      if (c.company_domain) domains.add(c.company_domain.toLowerCase());
      else unknown++;
    }
    return domains.size + unknown;
  })();
  // Default to the pattern method (the default) until the config loads.
  const waterfallKind = enrichWaterfallCfg?.kind ?? "pattern";
  const waterfallDisabled = enrichWaterfallCfg
    ? !enrichWaterfallCfg.enabled || enrichWaterfallCfg.kind === "off"
    : false;
  const waterfallEstimate =
    waterfallKind === "apify"
      ? estimateBoviCost(enrichWaterfallDomains)
      : waterfallKind === "scrape"
        ? estimateScrapeCost(enrichWaterfallDomains)
        : waterfallKind === "pattern"
          ? estimatePatternMvCost(enrichNeedsEmail)
          : 0;
  const enrichEstimate =
    (enrichRunProfiles ? enrichNeedsEmail * ENRICH_COST_PROFILE : 0) +
    (enrichRunDomains
      ? enrichNeedsDomainLinkedin * ENRICH_COST_DOMAIN +
        enrichNeedsDomainDiscovery * ENRICH_COST_DISCOVERY
      : 0) +
    (enrichRunWaterfall ? waterfallEstimate : 0) +
    (enrichRunActivity ? enrichActivityCount * ENRICH_COST_ACTIVITY : 0) +
    (enrichRunVerify ? enrichVerifyCount * ENRICH_COST_VERIFY : 0);
  const unverifiedSelected = selectedContacts.filter(
    (c) =>
      !c.email ||
      c.email_verification_status === "invalid" ||
      c.email_verification_status === "disposable",
  ).length;

  async function handleStartEnrichment() {
    if (selectedIds.size === 0) return;
    setEnrichStarting(true);
    setEnrichError(null);
    try {
      const res = await fetch(appUrl("/api/admin/contacts/enrich/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_ids: Array.from(selectedIds),
          run_profiles: enrichRunProfiles,
          run_domains: enrichRunDomains,
          run_waterfall: enrichRunWaterfall,
          run_activity: enrichRunActivity,
          run_verify: enrichRunVerify,
          run_naming: enrichRunNaming,
          include_catch_all: enrichIncludeCatchAll,
          validate_catch_all: enrichValidateCatchAll,
        }),
      });
      const data = (await res.json()) as {
        run_id?: string;
        total?: number;
        error?: string;
        skipped?: Record<string, number>;
      };
      if (!res.ok || !data.run_id) {
        setEnrichError(data.error ?? `Failed to start enrichment (${res.status})`);
        return;
      }
      setActiveRunId(data.run_id);
      setEnrichDialogOpen(false);
      setSelectedIds(new Set());
      const skippedTotal = data.skipped
        ? Object.values(data.skipped).reduce((a, b) => a + b, 0)
        : 0;
      toast.success(
        `Enrichment started for ${data.total ?? 0} contact${data.total === 1 ? "" : "s"}` +
          (skippedTotal ? ` — ${skippedTotal} skipped (already enriched or missing data)` : ""),
      );
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnrichStarting(false);
    }
  }

  async function handleBulkAssignCampaign() {
    if (!selectedCampaignId || selectedIds.size === 0) return;
    setAssigning(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await fetch(appUrl("/api/admin/contacts/push-to-campaign"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_ids: ids,
          campaign_id: selectedCampaignId,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        assigned?: number;
        queued?: number;
        already_queued?: number;
        skipped_no_email?: number;
        skipped_invalid?: number;
        queued_to_dispatcher?: boolean;
        daily_cap?: number;
        estimated_drain_days?: number | null;
        campaign_name?: string;
        reason?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? `Failed (${res.status})`);
        return;
      }

      const name =
        data.campaign_name ?? campaignMap.get(selectedCampaignId) ?? "campaign";
      const assigned = data.assigned ?? 0;

      if (data.queued_to_dispatcher) {
        const queued = data.queued ?? 0;
        const cap = data.daily_cap ?? 66;
        const days = data.estimated_drain_days ?? null;
        const parts: string[] = [`queued ${queued}`];
        if ((data.already_queued ?? 0) > 0)
          parts.push(`${data.already_queued} already pending`);
        if ((data.skipped_no_email ?? 0) > 0)
          parts.push(`${data.skipped_no_email} no email`);
        const drainHint =
          days && days > 0
            ? ` — will enroll at ${cap}/day over ~${days} day${days === 1 ? "" : "s"}`
            : "";
        toast.success(
          `Added ${assigned} contact${assigned === 1 ? "" : "s"} to ${name} — ${parts.join(", ")}${drainHint}`,
        );
      } else {
        toast.success(
          `Assigned ${assigned} contact${assigned === 1 ? "" : "s"} to ${name}${data.reason ? ` (${data.reason})` : ""}`,
        );
      }

      setSelectedIds(new Set());
      setCampaignDialogOpen(false);
      setSelectedCampaignId("");
      await refetch();
      await swrMutate("admin-contacts-with-pipeline");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to assign campaign: ${message}`);
    } finally {
      setAssigning(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-28 bg-muted/50" />
          ))}
        </div>
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  function openForAdd() {
    setForm({ ...EMPTY_FORM, owner: ownerView });
    setDialogMode("add");
  }

  function openForEdit(contact: Contact) {
    setForm(contactToForm(contact));
    setDialogMode(contact);
  }

  function closeDialog() {
    setDialogMode(null);
    setForm(EMPTY_FORM);
  }

  const editing = dialogMode && dialogMode !== "add" ? dialogMode : null;
  const isDialogOpen = dialogMode !== null;

  async function handleSubmit() {
    if (!form.email.trim() && !form.linkedin.trim()) return;
    if (form.owner === "client" && !form.clientId) {
      alert("Client contacts must be assigned to a client.");
      return;
    }
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const now = new Date().toISOString();

      // Owner enforcement: LeadStart contacts never have client_id; Client
      // contacts never have pipeline_stage. The Prospects kanban additionally
      // filters on client_id IS NULL so client contacts can't leak in.
      const resolvedClientId =
        form.owner === "leadstart" ? null : form.clientId || null;
      const nextStage: ProspectStage | null =
        form.owner === "client"
          ? null
          : form.pipelineStage === "none"
            ? null
            : form.pipelineStage;
      const prevStage: ProspectStage | null = editing?.pipeline_stage ?? null;

      // Pipeline state transitions. Null means "not in the pipeline".
      // Entering the pipeline sets sort order (bottom of the target column)
      // and added_at; leaving clears them.
      const pipelinePatch: {
        pipeline_stage: ProspectStage | null;
        pipeline_sort_order?: number;
        pipeline_added_at?: string | null;
      } = { pipeline_stage: nextStage };
      if (nextStage && !prevStage) {
        pipelinePatch.pipeline_sort_order = allContacts.filter(
          (c) => c.pipeline_stage === nextStage,
        ).length;
        pipelinePatch.pipeline_added_at = now;
      } else if (!nextStage && prevStage) {
        pipelinePatch.pipeline_added_at = null;
      }

      const basePayload = {
        first_name: form.firstName.trim() || null,
        last_name: form.lastName.trim() || null,
        email: form.email.trim() || null,
        company_name: form.company.trim() || null,
        title: form.title.trim() || null,
        phone: form.phone.trim() || null,
        linkedin_url: form.linkedin.trim() || null,
        tags,
        notes: form.notes.trim() || null,
        client_id: resolvedClientId,
        updated_at: now,
      };

      if (editing) {
        const { error } = await supabase
          .from("contacts")
          .update({ ...basePayload, ...pipelinePatch })
          .eq("id", editing.id);
        if (error) {
          alert(`Failed to save contact: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("contacts").insert({
          ...basePayload,
          ...pipelinePatch,
          id: crypto.randomUUID(),
          organization_id: organizationId,
          enrichment_data: {},
          source: null,
          campaign_id: null,
          status: "new",
          created_at: now,
        });
        if (error) {
          alert(`Failed to add contact: ${error.message}`);
          return;
        }
      }
      await refetch();
      // Prospects kanban reads from a separate SWR cache key — invalidate
      // it so a contact added/edited with a pipeline stage shows up there
      // without a manual reload. Same pattern as the import-CSV path.
      await swrMutate("admin-contacts-with-pipeline");
      closeDialog();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing) return;
    const label =
      [editing.first_name, editing.last_name].filter(Boolean).join(" ") ||
      editing.email ||
      "this contact";
    if (
      !confirm(
        `Delete ${label}? This permanently removes the contact and cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("contacts")
        .delete()
        .eq("id", editing.id);
      if (error) {
        alert(`Failed to delete contact: ${error.message}`);
        return;
      }
      await refetch();
      // Pipeline kanban reads from a separate cache key — invalidate it so a
      // deleted prospect doesn't linger on /admin/prospects.
      await swrMutate("admin-contacts-with-pipeline");
      closeDialog();
      toast.success(`Deleted ${label}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        actions={
          <>
            <Button onClick={() => setImportOpen(true)} variant="outline">
              <Upload size={16} className="mr-1" />
              Import CSV
            </Button>
            <Button onClick={openForAdd}>
              <Plus size={16} className="mr-1" />
              Add Contact
            </Button>
          </>
        }
      />

      {/* Owner toggle — separates LeadStart's own prospects from client
          campaign recipient lists. Only LeadStart contacts pipe into the
          Prospects kanban (enforced on the Prospects page query too). */}
      <div
        className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 p-1 shadow-sm"
        role="tablist"
      >
        {([
          { value: "leadstart", label: "LeadStart" },
          { value: "client", label: "Client" },
        ] as { value: OwnerView; label: string }[]).map((opt) => {
          const active = ownerView === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setOwnerView(opt.value)}
              className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-white text-[#0f172a] shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              style={active ? { color: "#2E37FE" } : undefined}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Contacts" value={totalContacts} icon={<Users size={18} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
        <StatCard label="Enriched" value={enrichedCount} icon={<CheckCircle size={18} className="text-blue-500" />} iconBg="bg-blue-50" valueColor="text-blue-600" />
        <StatCard label="Uploaded" value={uploadedCount} icon={<Upload size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Needs Enrichment" value={needsEnrichment} icon={<AlertCircle size={18} className="text-amber-500" />} iconBg="bg-amber-50" valueColor={needsEnrichment > 0 ? "text-amber-600" : undefined} />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search contacts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          style={{ height: "36px" }}
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v ?? "all") as ContactStatus | "all")}
        >
          <SelectTrigger className="w-[160px]" style={{ height: "36px" }}>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {VISIBLE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={emailStatusFilter}
          onValueChange={(v) => setEmailStatusFilter((v ?? "all") as EmailStatusFilter)}
        >
          <SelectTrigger className="w-[180px]" style={{ height: "36px" }}>
            <SelectValue placeholder="Email status" />
          </SelectTrigger>
          <SelectContent>
            {EMAIL_STATUS_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {ownerView === "client" ? (
          <Select
            value={clientFilter}
            onValueChange={(v) => setClientFilter(v ?? "all")}
          >
            <SelectTrigger className="w-[180px]" style={{ height: "36px" }}>
              <SelectValue placeholder="Client">
                {(value) => {
                  if (typeof value !== "string" || !value) return "Client";
                  if (value === "all") return "All Clients";
                  return clients.find((c) => c.id === value)?.name ?? value;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {/* Bulk action bar — visible whenever any contact is selected */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-[#2E37FE]/30 bg-[#2E37FE]/5 px-4 py-2.5">
          <p className="text-sm font-medium text-[#0f172a]">
            {selectedIds.size.toLocaleString()} contact
            {selectedIds.size === 1 ? "" : "s"} selected
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs"
            >
              Clear
            </Button>
            {ownerView === "client" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCampaignDialogOpen(true)}
                className="gap-1.5"
              >
                <Send size={14} />
                Add to Campaign
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEnrichError(null);
                setEnrichDialogOpen(true);
              }}
              className="gap-1.5"
            >
              <Sparkles size={14} />
              Enrich
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="gap-1.5"
            >
              <Trash2 size={14} />
              {bulkDeleting
                ? "Deleting..."
                : `Delete ${selectedIds.size.toLocaleString()}`}
            </Button>
          </div>
        </div>
      )}

      {/* Enrichment run progress */}
      <EnrichmentRunBanner
        runId={activeRunId}
        onDone={async () => {
          await refetch();
          await swrMutate("admin-contacts-with-pipeline");
        }}
        onDismiss={() => setActiveRunId(null)}
      />

      {/* Contacts table — row click opens edit dialog */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts found.</p>
          ) : (
            <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[88px]">
                    <div className="flex items-center gap-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      <label
                        className="flex flex-col items-center gap-0.5 cursor-pointer"
                        title="Select all on this page"
                      >
                        <input
                          type="checkbox"
                          checked={pageAllSelected}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                !pageAllSelected && pageSomeSelected;
                          }}
                          onChange={togglePageSelection}
                          className="h-3.5 w-3.5 rounded border-border accent-[#2E37FE] cursor-pointer"
                        />
                        <span>Page</span>
                      </label>
                      <label
                        className="flex flex-col items-center gap-0.5 cursor-pointer"
                        title="Select all matching the current filter (across pages)"
                      >
                        <input
                          type="checkbox"
                          checked={filteredAllSelected}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                !filteredAllSelected && filteredSomeSelected;
                          }}
                          onChange={toggleFilteredSelection}
                          className="h-3.5 w-3.5 rounded border-border accent-[#2E37FE] cursor-pointer"
                        />
                        <span>All</span>
                      </label>
                    </div>
                  </TableHead>
                  <SortableHead sortKey="fullName" sortConfig={sortConfig} onSort={requestSort}>
                    Name
                  </SortableHead>
                  <SortableHead sortKey="email" sortConfig={sortConfig} onSort={requestSort}>
                    Email
                  </SortableHead>
                  <SortableHead sortKey="phone" sortConfig={sortConfig} onSort={requestSort}>
                    Phone
                  </SortableHead>
                  <TableHead className="w-[80px]">LinkedIn</TableHead>
                  <SortableHead sortKey="company_name" sortConfig={sortConfig} onSort={requestSort}>
                    Company
                  </SortableHead>
                  <TableHead className="hidden lg:table-cell">Domain</TableHead>
                  <SortableHead sortKey="last_posted_at" sortConfig={sortConfig} onSort={requestSort}>
                    Last posted
                  </SortableHead>
                  <TableHead>Tags</TableHead>
                  {ownerView === "client" && <TableHead>Campaign</TableHead>}
                  <SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>
                    Created
                  </SortableHead>
                  <TableHead className="text-right w-[150px]">Pipeline Stage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => {
                  const pipelineStage = row.pipeline_stage;
                  const isSelected = selectedIds.has(row.id);
                  return (
                    <TableRow
                      key={row.id}
                      onClick={() => openForEdit(row)}
                      data-state={isSelected ? "selected" : undefined}
                      className="group cursor-pointer transition-colors hover:bg-muted/40 data-[state=selected]:bg-[#2E37FE]/5"
                    >
                      <TableCell
                        className="w-[88px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRowSelection(row.id)}
                          aria-label={`Select ${row.fullName}`}
                          className={`h-3.5 w-3.5 rounded border-border accent-[#2E37FE] cursor-pointer transition-opacity ${
                            isSelected
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                          }`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{row.fullName}</TableCell>
                      <TableCell className="text-muted-foreground">
                        <div className="flex flex-col gap-0.5">
                          <span className="inline-flex items-center gap-1.5">
                            {row.email ?? <span className="text-xs">—</span>}
                            {row.email && row.email_tier === "catch_all" && (
                              <Badge
                                variant="secondary"
                                className="border-amber-200 bg-amber-50 text-amber-700 text-[10px]"
                                title="Pattern guess on a catch-all domain — the mailbox can't be individually verified (confidence 40); sends go out flagged risky"
                              >
                                Catch-all
                              </Badge>
                            )}
                            {row.email && row.email_tier === "company" && (
                              <Badge
                                variant="secondary"
                                className="border-slate-200 bg-slate-50 text-slate-600 text-[10px]"
                                title="Generic company inbox backfilled from the website scrape — not a personal address"
                              >
                                Company inbox
                              </Badge>
                            )}
                            {(() => {
                              const b = verificationBadge(row.email_verification_status);
                              return b ? (
                                <Badge
                                  variant="secondary"
                                  className={`${b.className} text-[10px]`}
                                  title={[
                                    row.email_verification_subresult,
                                    row.email_verified_at &&
                                      `checked ${new Date(row.email_verified_at).toLocaleDateString()}`,
                                    row.email_did_you_mean &&
                                      `did you mean ${row.email_did_you_mean}?`,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                >
                                  {b.label}
                                </Badge>
                              ) : null;
                            })()}
                          </span>
                          {row.company_email && (
                            <span
                              title="Generic company inbox"
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80"
                            >
                              <span className="rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                co
                              </span>
                              {row.company_email}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.phone || row.company_phone ? (
                          <div className="flex flex-col gap-0.5">
                            {row.phone && (
                              <a
                                href={`tel:${row.phone}`}
                                onClick={(e) => e.stopPropagation()}
                                className="hover:text-[#2E37FE] hover:underline"
                              >
                                {row.phone}
                              </a>
                            )}
                            {row.company_phone && (
                              <a
                                href={`tel:${row.company_phone}`}
                                onClick={(e) => e.stopPropagation()}
                                title="Company main line"
                                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-[#2E37FE] hover:underline"
                              >
                                <span className="rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                  co
                                </span>
                                {row.company_phone}
                              </a>
                            )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="w-[80px]">
                        {row.linkedin_url ? (
                          <a
                            href={
                              row.linkedin_url.startsWith("http")
                                ? row.linkedin_url
                                : `https://${row.linkedin_url}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Open LinkedIn profile"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#0A66C2] hover:bg-[#0A66C2]/10 transition-colors"
                          >
                            <LinkedinIcon size={14} />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.company_name || "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {row.company_domain ?? <span className="text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {timeAgo(row.last_posted_at)}
                      </TableCell>
                      <TableCell>
                        <TagsCell tags={row.tags ?? []} />
                      </TableCell>
                      {ownerView === "client" && (
                        <TableCell className="text-muted-foreground">
                          {row.campaign_id
                            ? campaignMap.get(row.campaign_id) || "—"
                            : "—"}
                        </TableCell>
                      )}
                      <TableCell className="text-muted-foreground">
                        {new Date(row.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </TableCell>
                      <TableCell className="text-right">
                        {pipelineStage ? (
                          <Badge
                            variant="outline"
                            className="text-[11px] font-medium text-[#2E37FE] border-[#2E37FE]/30 bg-[#2E37FE]/5"
                          >
                            <TrendingUp size={11} className="mr-1" />
                            {pipelineStage}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <PaginationControls
              currentPage={safePage}
              totalItems={sorted.length}
              pageSize={CONTACTS_PAGE_SIZE}
              onPageChange={setPage}
            />
            </>
          )}
        </CardContent>
      </Card>

      {/* Unified Contact dialog — Add mode (blank) or Edit mode (pre-filled) */}
      <Dialog open={isDialogOpen} onOpenChange={(v) => { if (!v) closeDialog(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-border/50 shrink-0">
            <DialogTitle>
              {editing ? "Edit" : "Add"}{" "}
              {form.owner === "leadstart" ? "LeadStart" : "Client"} Contact
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto px-6 pt-4 pb-6 flex-1 min-h-0">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">First Name</Label>
                <Input
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  placeholder="First name"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Last Name</Label>
                <Input
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  placeholder="Last name"
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="email@company.com"
                style={{ height: "36px" }}
              />
              <p className="text-[11px] text-muted-foreground">Email or LinkedIn URL required.</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Company</Label>
                <Input
                  value={form.company}
                  onChange={(e) => setForm({ ...form, company: e.target.value })}
                  placeholder="Company name"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Title</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Job title"
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Phone</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="(555) 000-0000"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">LinkedIn URL</Label>
                <Input
                  value={form.linkedin}
                  onChange={(e) => setForm({ ...form, linkedin: e.target.value })}
                  placeholder="https://linkedin.com/in/..."
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Tags (comma-separated)</Label>
              <Input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="e.g. saas, decision-maker, warm"
                style={{ height: "36px" }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Any notes about this contact..."
                rows={2}
              />
            </div>
            {/* Owner-specific field: LeadStart contacts get a Pipeline Stage
                selector; Client contacts get a required Client selector. The
                split is enforced in handleSubmit so the DB stays clean. */}
            {form.owner === "leadstart" ? (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Pipeline Stage</Label>
                <Select
                  value={form.pipelineStage}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      pipelineStage: (v ?? "none") as ProspectStage | "none",
                    })
                  }
                >
                  <SelectTrigger className="w-full" style={{ height: "36px" }}>
                    <SelectValue placeholder="Not in pipeline">
                      {form.pipelineStage === "none"
                        ? "Not in pipeline"
                        : pipelineStageLabel(form.pipelineStage)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    className="min-w-[220px]"
                    alignItemWithTrigger={false}
                  >
                    <SelectItem value="none">Not in pipeline</SelectItem>
                    {PIPELINE_STAGES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Setting a stage puts this contact in the Prospects kanban.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Client *</Label>
                <Select
                  value={form.clientId || ""}
                  onValueChange={(v) =>
                    setForm({ ...form, clientId: v ?? "" })
                  }
                >
                  <SelectTrigger className="w-full" style={{ height: "36px" }}>
                    <SelectValue placeholder="Select a client">
                      {form.clientId
                        ? clients.find((c) => c.id === form.clientId)?.name ??
                          "Select a client"
                        : "Select a client"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    className="min-w-[220px]"
                    alignItemWithTrigger={false}
                  >
                    {clients.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No clients yet.
                      </div>
                    ) : (
                      clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Recipient on this client&apos;s cold email campaigns.
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              {editing && (
                <Button
                  variant="ghost"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={handleDelete}
                  disabled={deleting || saving}
                >
                  <Trash2 size={14} className="mr-1" />
                  {deleting ? "Deleting..." : "Delete"}
                </Button>
              )}
              <div className="flex flex-1 gap-2">
                <Button variant="outline" className="flex-1" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  style={{ background: "#2E37FE" }}
                  disabled={
                    (!form.email.trim() && !form.linkedin.trim()) ||
                    saving ||
                    deleting ||
                    (form.owner === "client" && !form.clientId)
                  }
                  onClick={handleSubmit}
                >
                  {saving ? "Saving..." : editing ? "Save changes" : "Add Contact"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ImportContactsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        ownerView={ownerView}
        organizationId={organizationId ?? null}
        clients={clients}
        existingContactCount={(stage) =>
          allContacts.filter((c) => c.pipeline_stage === stage).length
        }
        onImported={async () => {
          await refetch();
          // Bulk imports with pipeline_stage need to reach the Prospects
          // kanban too — invalidate its specific cache key.
          await swrMutate("admin-contacts-with-pipeline");
        }}
        onEnrichStarted={(runId) => {
          setActiveRunId(runId);
          setImportOpen(false);
        }}
      />

      {/* Add to Campaign dialog */}
      <Dialog
        open={campaignDialogOpen}
        onOpenChange={(v) => {
          if (!v) {
            setCampaignDialogOpen(false);
            setSelectedCampaignId("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add to Campaign</DialogTitle>
          </DialogHeader>
          {isMixedClients ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                The selected contacts belong to different clients. Filter to a
                single client first, then try again.
              </p>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={() => setCampaignDialogOpen(false)}
                >
                  Close
                </Button>
              </div>
            </div>
          ) : eligibleCampaigns.length === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                No campaigns found for{" "}
                <span className="font-medium text-foreground">
                  {commonClientId ? clientMap.get(commonClientId) : "this client"}
                </span>
                . Create a campaign for this client first.
              </p>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  onClick={() => setCampaignDialogOpen(false)}
                >
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Assign {selectedIds.size} contact
                {selectedIds.size === 1 ? "" : "s"} to a campaign for{" "}
                <span className="font-medium text-foreground">
                  {commonClientId
                    ? clientMap.get(commonClientId)
                    : "this client"}
                </span>
                . Contacts are assigned to the campaign here — then review and
                enroll them into its sending sequence from the campaign page.
              </p>
              {unverifiedSelected > 0 && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                  {unverifiedSelected} selected contact{unverifiedSelected === 1 ? " has" : "s have"} no
                  verified email — use a LinkedIn campaign for those.
                </p>
              )}
              <Select
                value={selectedCampaignId}
                onValueChange={(v) => setSelectedCampaignId(v ?? "")}
              >
                <SelectTrigger className="w-full" style={{ height: "36px" }}>
                  <SelectValue placeholder="Select a campaign">
                    {selectedCampaignId
                      ? campaignMap.get(selectedCampaignId) ??
                        "Select a campaign"
                      : "Select a campaign"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  className="min-w-[220px]"
                  alignItemWithTrigger={false}
                >
                  {eligibleCampaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCampaignDialogOpen(false);
                    setSelectedCampaignId("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!selectedCampaignId || assigning}
                  onClick={handleBulkAssignCampaign}
                  style={{ background: "#2E37FE" }}
                >
                  {assigning ? "Assigning..." : "Assign"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Enrich dialog */}
      <Dialog
        open={enrichDialogOpen}
        onOpenChange={(v) => {
          setEnrichDialogOpen(v);
          if (!v) setEnrichError(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Enrich contacts</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {selectedIds.size} contact{selectedIds.size === 1 ? "" : "s"} selected ·{" "}
              {enrichNeedsDomain} need a company domain · {enrichNeedsEmail} need an email.
            </p>
            <div className="space-y-2.5">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichRunProfiles}
                  onChange={(e) => setEnrichRunProfiles(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Find emails from LinkedIn profiles (HarvestAPI)
                  <span className="block text-[11px] text-muted-foreground">
                    $0.01 each · only charged when a profile is searchable
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichRunDomains}
                  onChange={(e) => setEnrichRunDomains(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Resolve company domains
                  <span className="block text-[11px] text-muted-foreground">
                    $0.004 each via LinkedIn
                    {discoveryOn ? " · +$0.005 web lookup when the company has no LinkedIn page" : ""}
                  </span>
                </span>
              </label>
              <label
                className={`flex items-start gap-2 text-sm ${
                  waterfallDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={enrichRunWaterfall}
                  disabled={waterfallDisabled}
                  onChange={(e) => setEnrichRunWaterfall(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Second pass on misses
                  <span className="block text-[11px] text-muted-foreground">
                    {waterfallDisabled
                      ? "turned off in Settings → Integrations"
                      : waterfallKind === "pattern"
                        ? `guesses the common email patterns + verifies each with Million Verifier ≈ $${estimatePatternMvCost(1).toFixed(3)} per contact`
                        : waterfallKind === "scrape"
                          ? `scrapes each company site for phone + emails ≈ $${estimateScrapeCost(1).toFixed(3)} per company (compute; +MV credits if it falls through to pattern)`
                          : `runs the bovi pattern finder ≈ $${estimateBoviCost(1).toFixed(3)} per company (billed per found email)`}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichRunActivity}
                  onChange={(e) => setEnrichRunActivity(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Score LinkedIn activity (last posted){" "}
                  <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  <span className="block text-[11px] text-muted-foreground">
                    ≈ $0.005 per profile · stamps a recency rank to prioritize outreach
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichRunVerify}
                  onChange={(e) => setEnrichRunVerify(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Verify emails (Million Verifier){" "}
                  <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  <span className="block text-[11px] text-muted-foreground">
                    ≈ ${ENRICH_COST_VERIFY.toFixed(4)} per email · marks each found address
                    valid / risky / invalid in the report
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichRunNaming}
                  onChange={(e) => setEnrichRunNaming(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Find owner names (decision-maker){" "}
                  <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  <span className="block text-[11px] text-muted-foreground">
                    ≈ $0.015 per business · for name-less company leads (e.g. Google Maps) —
                    finds the owner&apos;s name &amp; title, then builds their personal email
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichIncludeCatchAll}
                  onChange={(e) => setEnrichIncludeCatchAll(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Include catch-all guesses{" "}
                  <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  <span className="block text-[11px] text-muted-foreground">
                    no extra cost · on domains that accept every address, keep the best
                    pattern guess (flagged Catch-all, confidence 40) instead of discarding
                    it — sends go out flagged risky and bounces auto-suppress
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={enrichValidateCatchAll}
                  onChange={(e) => setEnrichValidateCatchAll(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-[#2E37FE] cursor-pointer"
                />
                <span>
                  Validate catch-all emails{" "}
                  <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  <span className="block text-[11px] text-muted-foreground">
                    ~$0.049 per hit · recover genuinely deliverable emails on catch-all domains via
                    Findymail (charged only when one is found). Needs a Findymail key.
                  </span>
                </span>
              </label>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Even without the verify add-on, found emails are re-checked by Million
              Verifier just before the first send.
            </p>
            <p className="text-xs text-muted-foreground">
              Estimated cost: up to ~${enrichEstimate.toFixed(3)}
            </p>
            {enrichError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
                {enrichError}{" "}
                <Link href="/admin/settings/api" className="underline">
                  Open Integrations settings
                </Link>
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEnrichDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                style={{ background: "#2E37FE" }}
                disabled={
                  enrichStarting ||
                  (!enrichRunProfiles &&
                    !enrichRunDomains &&
                    !enrichRunWaterfall &&
                    !enrichRunActivity &&
                    !enrichRunVerify &&
                    !enrichRunNaming) ||
                  (enrichNeedsDomain === 0 &&
                    enrichNeedsEmail === 0 &&
                    enrichActivityCount === 0 &&
                    enrichVerifyCount === 0)
                }
                onClick={handleStartEnrichment}
              >
                {enrichStarting ? "Starting…" : "Start enrichment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
