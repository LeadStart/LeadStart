"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useUser } from "@/hooks/use-user";
import { ApifySpendCard } from "./apify-spend-card";
import { WaterfallSettingsCard } from "./waterfall-settings-card";
import { RegistrarSettingsCard } from "./registrar-settings-card";
import { AutomationsSettingsCard } from "./automations-settings-card";
import { MsOauthSettingsCard } from "./ms-oauth-settings-card";
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  Mail,
  CreditCard,
  Search,
  Sparkles,
  Compass,
  AtSign,
  Activity,
  MailCheck,
  Bot,
  Receipt,
  SlidersHorizontal,
  Globe,
  KeyRound,
  Zap,
  ChevronRight,
} from "lucide-react";
import type { Organization } from "@/types/app";
import { appUrl } from "@/lib/api-url";

// Brand icon: Lucide's brand-icon set was removed upstream, so inline.
function LinkedinIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
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

// Generate hour options 1-12 for AM/PM display
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i === 0 ? 12 : i),
  label: String(i === 0 ? 12 : i),
}));

const AMPM_OPTIONS = [
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
];

// Convert 24h to 12h + AM/PM
function to12h(hour24: string): { hour: string; ampm: string } {
  const h = parseInt(hour24);
  if (h === 0) return { hour: "12", ampm: "AM" };
  if (h === 12) return { hour: "12", ampm: "PM" };
  if (h > 12) return { hour: String(h - 12), ampm: "PM" };
  return { hour: String(h), ampm: "AM" };
}

// Convert 12h + AM/PM to 24h
function to24h(hour12: string, ampm: string): string {
  let h = parseInt(hour12);
  if (ampm === "AM" && h === 12) h = 0;
  else if (ampm === "PM" && h !== 12) h += 12;
  return String(h);
}

// The provider grid. Grouped by what each integration affects, mirroring the
// Settings hub, and rendered 3-across. Clicking a card opens that provider's
// settings in a dialog; the bodies live in panelFor() inside the component
// because they read its state.
type Provider = {
  title: string;
  blurb: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tile: string;
  iconClass: string;
};

const PROVIDERS: Record<string, Provider> = {
  nativeEmail: { title: "Native Email (Google)", blurb: "Send from client-owned Google Workspace inboxes.", icon: AtSign, tile: "bg-[#EA4335]", iconClass: "text-white" },
  msOauth:     { title: "Microsoft OAuth app", blurb: "Outlook and Microsoft 365 inboxes as placement seeds.", icon: KeyRound, tile: "bg-sky-600", iconClass: "text-white" },
  registrars:  { title: "Domain registrars", blurb: "Buy sending domains and write their DNS.", icon: Globe, tile: "bg-indigo-600", iconClass: "text-white" },
  resend:      { title: "Resend", blurb: "Delivery for KPI reports and notifications.", icon: Mail, tile: "bg-emerald-50", iconClass: "text-emerald-500" },
  inboxHealth: { title: "Inbox health", blurb: "Hourly deliverability scoring and auto-pause.", icon: Activity, tile: "bg-emerald-600", iconClass: "text-white" },

  apify:       { title: "Apify", blurb: "Runs the enrichment and prospecting actors.", icon: Bot, tile: "bg-emerald-600", iconClass: "text-white" },
  apifySpend:  { title: "Apify spend", blurb: "Actual Apify charges this billing cycle.", icon: Receipt, tile: "bg-slate-700", iconClass: "text-white" },
  waterfall:   { title: "Enrichment waterfall", blurb: "Which method runs, and the per-company cost cap.", icon: SlidersHorizontal, tile: "bg-indigo-600", iconClass: "text-white" },
  scrapio:     { title: "Scrap.io", blurb: "Lead enrichment for the Prospecting tab.", icon: Search, tile: "bg-violet-500", iconClass: "text-white" },
  emailVerify: { title: "Email verification", blurb: "Pre-send check on every recipient.", icon: MailCheck, tile: "bg-teal-600", iconClass: "text-white" },
  findymail:   { title: "Catch-all validation", blurb: "Recovers emails on catch-all domains.", icon: MailCheck, tile: "bg-indigo-600", iconClass: "text-white" },
  unipile:     { title: "Unipile (LinkedIn)", blurb: "LinkedIn sequences and reply ingestion.", icon: LinkedinIcon, tile: "bg-[#0A66C2]", iconClass: "text-white" },

  anthropic:   { title: "Anthropic", blurb: "Decision-maker extraction in Prospecting.", icon: Sparkles, tile: "bg-amber-500", iconClass: "text-white" },
  perplexity:  { title: "Perplexity", blurb: "Web-search fallback for finding an owner.", icon: Compass, tile: "bg-sky-500", iconClass: "text-white" },

  stripe:      { title: "Stripe", blurb: "Billing and subscriptions.", icon: CreditCard, tile: "bg-violet-50", iconClass: "text-violet-500" },

  automations: { title: "Internal automations", blurb: "Alert the team when a lead replies.", icon: Zap, tile: "bg-violet-600", iconClass: "text-white" },
  dataSync:    { title: "Data Sync Schedule", blurb: "When campaign analytics refresh.", icon: Clock, tile: "bg-amber-50", iconClass: "text-amber-500" },
};

const PROVIDER_GROUPS: { label: string; ids: string[] }[] = [
  { label: "Sending", ids: ["nativeEmail", "msOauth", "registrars", "resend", "inboxHealth"] },
  { label: "Finding contacts", ids: ["apify", "apifySpend", "waterfall", "scrapio", "emailVerify", "findymail", "unipile"] },
  { label: "AI", ids: ["anthropic", "perplexity"] },
  { label: "Money", ids: ["stripe"] },
  { label: "System", ids: ["automations", "dataSync"] },
];

const STATUS = {
  connected: { label: "Connected", cls: "badge-green" },
  notset: { label: "Not set", cls: "badge-slate" },
  optional: { label: "Optional", cls: "badge-slate" },
  soon: { label: "Coming soon", cls: "badge-slate" },
} as const;
type StatusKey = keyof typeof STATUS;

export default function IntegrationsPage() {
  const { organizationId } = useUser();
  // Which provider's dialog is open. null = the grid.
  const [openId, setOpenId] = useState<string | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [resendKey, setResendKey] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [scrapioKey, setScrapioKey] = useState("");
  const [syncHour12, setSyncHour12] = useState("6");
  const [syncAmPm, setSyncAmPm] = useState("AM");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [savingResend, setSavingResend] = useState(false);
  const [savingScrapio, setSavingScrapio] = useState(false);
  const [testingScrapio, setTestingScrapio] = useState(false);
  const [scrapioTestResult, setScrapioTestResult] = useState<
    | { kind: "success"; subscription: Record<string, unknown> }
    | { kind: "fail"; message: string }
    | null
  >(null);
  const [resettingBlacklist, setResettingBlacklist] = useState(false);
  const [blacklistResetResult, setBlacklistResetResult] = useState<
    | { kind: "success"; note?: string }
    | { kind: "fail"; message: string }
    | null
  >(null);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [resendSaved, setResendSaved] = useState(false);
  const [scrapioSaved, setScrapioSaved] = useState(false);

  // Anthropic + Perplexity (Decision-maker enrichment, migration 00044)
  const [anthropicKey, setAnthropicKey] = useState("");
  const [savingAnthropic, setSavingAnthropic] = useState(false);
  const [anthropicSaved, setAnthropicSaved] = useState(false);
  const [testingAnthropic, setTestingAnthropic] = useState(false);
  const [anthropicTestResult, setAnthropicTestResult] = useState<
    { kind: "success"; model: string } | { kind: "fail"; message: string } | null
  >(null);
  const [perplexityKey, setPerplexityKey] = useState("");
  const [savingPerplexity, setSavingPerplexity] = useState(false);
  const [perplexitySaved, setPerplexitySaved] = useState(false);
  const [testingPerplexity, setTestingPerplexity] = useState(false);
  const [perplexityTestResult, setPerplexityTestResult] = useState<
    { kind: "success"; model: string } | { kind: "fail"; message: string } | null
  >(null);

  // Unipile (LinkedIn channel, migration 00046)
  const [unipileKey, setUnipileKey] = useState("");
  const [unipileDsn, setUnipileDsn] = useState("");
  const [savingUnipile, setSavingUnipile] = useState(false);
  const [unipileSaved, setUnipileSaved] = useState(false);
  const [testingUnipile, setTestingUnipile] = useState(false);
  const [unipileTestResult, setUnipileTestResult] = useState<
    "success" | "fail" | null
  >(null);

  // Native email: Google service account w/ domain-wide delegation (migration 00056)
  const [gmailSaEmail, setGmailSaEmail] = useState("");
  const [gmailSaKey, setGmailSaKey] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);
  const [gmailSaved, setGmailSaved] = useState(false);

  // Inbox health (migration 00061): Spamhaus DQS key for domain-blocklist
  // checks + the auto-pause offline threshold (blank = alert-only).
  const [spamhausKey, setSpamhausKey] = useState("");
  const [offlineThreshold, setOfflineThreshold] = useState("");
  // Seed placement cadence (migration 00068): days between automatic neutral
  // probes per active mailbox; blank = manual runs only.
  const [placementInterval, setPlacementInterval] = useState("7");
  const [savingInboxHealth, setSavingInboxHealth] = useState(false);
  const [inboxHealthError, setInboxHealthError] = useState<string | null>(null);
  const [inboxHealthSaved, setInboxHealthSaved] = useState(false);
  const [testingSpamhaus, setTestingSpamhaus] = useState(false);
  const [spamhausTestResult, setSpamhausTestResult] = useState<
    { kind: "success" } | { kind: "fail"; message: string } | null
  >(null);

  // Email verification: Million Verifier (migration 00069): API key + the
  // last-seen credit balance / error surfaced on the card.
  const [millionVerifierKey, setMillionVerifierKey] = useState("");
  const [millionVerifierMeta, setMillionVerifierMeta] = useState<{
    credits: number | null;
    checkedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  }>({ credits: null, checkedAt: null, lastError: null, lastErrorAt: null });
  const [savingMillionVerifier, setSavingMillionVerifier] = useState(false);
  const [millionVerifierSaved, setMillionVerifierSaved] = useState(false);
  const [millionVerifierError, setMillionVerifierError] = useState<string | null>(null);
  const [testingMillionVerifier, setTestingMillionVerifier] = useState(false);
  const [millionVerifierTestResult, setMillionVerifierTestResult] = useState<
    { kind: "success"; credits: number } | { kind: "fail"; message: string } | null
  >(null);

  // Findymail (catch-all email validation, migration 00099)
  const [findymailKey, setFindymailKey] = useState("");
  const [findymailMeta, setFindymailMeta] = useState<{ credits: number | null; checkedAt: string | null }>({
    credits: null,
    checkedAt: null,
  });
  const [savingFindymail, setSavingFindymail] = useState(false);
  const [findymailSaved, setFindymailSaved] = useState(false);
  const [findymailError, setFindymailError] = useState<string | null>(null);
  const [testingFindymail, setTestingFindymail] = useState(false);
  const [findymailTestResult, setFindymailTestResult] = useState<
    { kind: "success"; credits: number } | { kind: "fail"; message: string } | null
  >(null);

  // Apify (Contacts → Enrich: profile→email, company→domain, waterfall, migration 00070)
  const [apifyKey, setApifyKey] = useState("");
  const [savingApify, setSavingApify] = useState(false);
  const [apifySaved, setApifySaved] = useState(false);
  const [testingApify, setTestingApify] = useState(false);
  const [apifyTestResult, setApifyTestResult] = useState<
    { kind: "success"; username: string; plan: string | null } | { kind: "fail"; message: string } | null
  >(null);

  useEffect(() => {
    if (!organizationId) return;
    const supabase = createClient();
    supabase
      .from("organizations")
      .select("*")
      .eq("id", organizationId)
      .single()
      .then(({ data }: { data: unknown }) => {
        if (data) {
          const typedOrg = data as Organization & {
            sync_hour?: string;
            resend_api_key?: string;
            email_from?: string;
          };
          setOrg(typedOrg);
          if (typedOrg.sync_hour) {
            const { hour, ampm } = to12h(typedOrg.sync_hour);
            setSyncHour12(hour);
            setSyncAmPm(ampm);
          }
          if (typedOrg.resend_api_key) setResendKey(typedOrg.resend_api_key);
          if (typedOrg.email_from) setEmailFrom(typedOrg.email_from);
          if (typedOrg.scrapio_api_key) setScrapioKey(typedOrg.scrapio_api_key);
          const apifyOrg = data as { apify_api_key?: string | null };
          if (apifyOrg.apify_api_key) setApifyKey(apifyOrg.apify_api_key);
          // Decision-maker enrichment keys (migration 00044). Cast through
          // unknown because typedOrg's compile-time shape (Organization) is
          // stale w.r.t. the new columns until we update the type.
          const dmOrg = data as {
            anthropic_api_key?: string | null;
            perplexity_api_key?: string | null;
            unipile_api_key?: string | null;
            unipile_dsn?: string | null;
          };
          if (dmOrg.anthropic_api_key) setAnthropicKey(dmOrg.anthropic_api_key);
          if (dmOrg.perplexity_api_key) setPerplexityKey(dmOrg.perplexity_api_key);
          if (dmOrg.unipile_api_key) setUnipileKey(dmOrg.unipile_api_key);
          if (dmOrg.unipile_dsn) setUnipileDsn(dmOrg.unipile_dsn);
          // Inbox health (migration 00061). Separate cast: same reason as above.
          const ihOrg = data as {
            spamhaus_dqs_key?: string | null;
            inbox_health_offline_threshold?: number | null;
            placement_test_interval_days?: number | null;
          };
          if (ihOrg.spamhaus_dqs_key) setSpamhausKey(ihOrg.spamhaus_dqs_key);
          if (
            ihOrg.inbox_health_offline_threshold !== null &&
            ihOrg.inbox_health_offline_threshold !== undefined
          ) {
            setOfflineThreshold(String(ihOrg.inbox_health_offline_threshold));
          }
          // null = manual only (blank field); undefined = column not applied yet
          // (keep the default so the field isn't misleadingly empty).
          if (ihOrg.placement_test_interval_days !== undefined) {
            setPlacementInterval(
              ihOrg.placement_test_interval_days === null
                ? ""
                : String(ihOrg.placement_test_interval_days),
            );
          }
          // Native email service account (migration 00056).
          const gmOrg = data as {
            gmail_service_account_email?: string | null;
            gmail_service_account_key?: string | null;
          };
          if (gmOrg.gmail_service_account_email)
            setGmailSaEmail(gmOrg.gmail_service_account_email);
          if (gmOrg.gmail_service_account_key)
            setGmailSaKey(gmOrg.gmail_service_account_key);
          // Email verification: Million Verifier (migration 00069). Same
          // stale-type cast as above until 00069 is applied everywhere.
          const mvOrg = data as {
            millionverifier_api_key?: string | null;
            millionverifier_credits?: number | null;
            millionverifier_credits_checked_at?: string | null;
            millionverifier_last_error?: string | null;
            millionverifier_last_error_at?: string | null;
          };
          if (mvOrg.millionverifier_api_key) setMillionVerifierKey(mvOrg.millionverifier_api_key);
          setMillionVerifierMeta({
            credits: mvOrg.millionverifier_credits ?? null,
            checkedAt: mvOrg.millionverifier_credits_checked_at ?? null,
            lastError: mvOrg.millionverifier_last_error ?? null,
            lastErrorAt: mvOrg.millionverifier_last_error_at ?? null,
          });
          // Findymail (migration 00099). Stale-type cast until 00099 is applied.
          const fmOrg = data as {
            findymail_api_key?: string | null;
            findymail_credits?: number | null;
            findymail_credits_checked_at?: string | null;
          };
          if (fmOrg.findymail_api_key) setFindymailKey(fmOrg.findymail_api_key);
          setFindymailMeta({
            credits: fmOrg.findymail_credits ?? null,
            checkedAt: fmOrg.findymail_credits_checked_at ?? null,
          });
        }
      });
  }, [organizationId]);

  async function handleSaveScrapioKey() {
    if (!organizationId) return;
    setSavingScrapio(true);
    setScrapioSaved(false);

    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ scrapio_api_key: scrapioKey || null })
      .eq("id", organizationId);

    setScrapioSaved(true);
    setSavingScrapio(false);
    setTimeout(() => setScrapioSaved(false), 3000);
  }

  async function handleResetBlacklist() {
    if (
      !confirm(
        "Reset the Scrap.io blacklist for this org? Future searches will be allowed to re-pull every business they've ever fetched: credits WILL be charged again. This is intended for starting fresh on a region you scraped a long time ago.",
      )
    ) {
      return;
    }
    setResettingBlacklist(true);
    setBlacklistResetResult(null);
    try {
      const res = await fetch(
        appUrl("/api/admin/prospecting/blacklist/reset"),
        { method: "POST" },
      );
      const data = await res.json();
      if (res.ok) {
        setBlacklistResetResult({ kind: "success", note: data.note });
      } else {
        setBlacklistResetResult({
          kind: "fail",
          message: data.error ?? "Reset failed",
        });
      }
    } catch (err) {
      setBlacklistResetResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Reset failed",
      });
    } finally {
      setResettingBlacklist(false);
    }
  }

  async function handleTestScrapio() {
    setTestingScrapio(true);
    setScrapioTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/validate-key"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: scrapioKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setScrapioTestResult({ kind: "success", subscription: data.subscription ?? {} });
      } else {
        setScrapioTestResult({ kind: "fail", message: data.error ?? "Connection failed" });
      }
    } catch (err) {
      setScrapioTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingScrapio(false);
    }
  }

  async function handleSaveApifyKey() {
    if (!organizationId) return;
    setSavingApify(true);
    setApifySaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ apify_api_key: apifyKey || null })
      .eq("id", organizationId);
    setApifySaved(true);
    setSavingApify(false);
    setTimeout(() => setApifySaved(false), 3000);
  }

  async function handleTestApify() {
    setTestingApify(true);
    setApifyTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/apify/validate-key"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apifyKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setApifyTestResult({ kind: "success", username: data.username ?? "", plan: data.plan ?? null });
      } else {
        setApifyTestResult({ kind: "fail", message: data.error ?? "Connection failed" });
      }
    } catch (err) {
      setApifyTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingApify(false);
    }
  }

  async function handleSaveSchedule() {
    if (!organizationId) return;
    setSavingSchedule(true);
    setScheduleSaved(false);

    const syncHour24 = to24h(syncHour12, syncAmPm);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ sync_hour: syncHour24 })
      .eq("id", organizationId);

    setScheduleSaved(true);
    setSavingSchedule(false);
    setTimeout(() => setScheduleSaved(false), 3000);
  }

  async function handleSaveResend() {
    if (!organizationId) return;
    setSavingResend(true);
    setResendSaved(false);

    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        resend_api_key: resendKey,
        email_from: emailFrom,
      })
      .eq("id", organizationId);

    setResendSaved(true);
    setSavingResend(false);
    setTimeout(() => setResendSaved(false), 3000);
  }

  async function handleSaveAnthropic() {
    if (!organizationId) return;
    setSavingAnthropic(true);
    setAnthropicSaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ anthropic_api_key: anthropicKey || null })
      .eq("id", organizationId);
    setAnthropicSaved(true);
    setSavingAnthropic(false);
    setTimeout(() => setAnthropicSaved(false), 3000);
  }

  async function handleTestAnthropic() {
    setTestingAnthropic(true);
    setAnthropicTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/validate-anthropic"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: anthropicKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setAnthropicTestResult({ kind: "success", model: data.model ?? "" });
      } else {
        setAnthropicTestResult({ kind: "fail", message: data.error ?? "Connection failed" });
      }
    } catch (err) {
      setAnthropicTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingAnthropic(false);
    }
  }

  async function handleSavePerplexity() {
    if (!organizationId) return;
    setSavingPerplexity(true);
    setPerplexitySaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ perplexity_api_key: perplexityKey || null })
      .eq("id", organizationId);
    setPerplexitySaved(true);
    setSavingPerplexity(false);
    setTimeout(() => setPerplexitySaved(false), 3000);
  }

  async function handleTestPerplexity() {
    setTestingPerplexity(true);
    setPerplexityTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/validate-perplexity"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: perplexityKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setPerplexityTestResult({ kind: "success", model: data.model ?? "" });
      } else {
        setPerplexityTestResult({ kind: "fail", message: data.error ?? "Connection failed" });
      }
    } catch (err) {
      setPerplexityTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingPerplexity(false);
    }
  }

  async function handleSaveUnipile() {
    if (!organizationId) return;
    setSavingUnipile(true);
    setUnipileSaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        unipile_api_key: unipileKey || null,
        unipile_dsn: unipileDsn || null,
      })
      .eq("id", organizationId);
    setUnipileSaved(true);
    setSavingUnipile(false);
    setTimeout(() => setUnipileSaved(false), 3000);
  }

  async function handleTestUnipile() {
    setTestingUnipile(true);
    setUnipileTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/unipile/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: unipileKey, dsn: unipileDsn }),
      });
      setUnipileTestResult(res.ok ? "success" : "fail");
    } catch {
      setUnipileTestResult("fail");
    } finally {
      setTestingUnipile(false);
    }
  }

  async function handleSaveGmail() {
    if (!organizationId) return;
    setSavingGmail(true);
    setGmailSaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        gmail_service_account_email: gmailSaEmail.trim() || null,
        gmail_service_account_key: gmailSaKey.trim() || null,
      })
      .eq("id", organizationId);
    setGmailSaved(true);
    setSavingGmail(false);
    setTimeout(() => setGmailSaved(false), 3000);
  }

  async function handleSaveInboxHealth() {
    if (!organizationId) return;
    setSavingInboxHealth(true);
    setInboxHealthSaved(false);
    // Blank threshold → NULL (alert-only). A number is clamped to 1–100.
    const raw = offlineThreshold.trim();
    let threshold: number | null = null;
    if (raw !== "") {
      const n = Math.round(Number(raw));
      threshold = Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : null;
    }
    // Blank interval → NULL (manual only). A number is clamped to 1–90 days.
    const rawInterval = placementInterval.trim();
    let interval: number | null = null;
    if (rawInterval !== "") {
      const n = Math.round(Number(rawInterval));
      interval = Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : null;
    }
    const supabase = createClient();
    const { error } = await supabase
      .from("organizations")
      .update({
        spamhaus_dqs_key: spamhausKey.trim() || null,
        inbox_health_offline_threshold: threshold,
        placement_test_interval_days: interval,
      })
      .eq("id", organizationId);
    setSavingInboxHealth(false);
    if (error) {
      // Surface it rather than claiming "Saved": e.g. migration 00068 not
      // applied yet (unknown column) fails the whole update, key included.
      setInboxHealthError(error.message);
      return;
    }
    setInboxHealthError(null);
    // Reflect the clamped values back into the fields.
    setOfflineThreshold(threshold === null ? "" : String(threshold));
    setPlacementInterval(interval === null ? "" : String(interval));
    setInboxHealthSaved(true);
    setTimeout(() => setInboxHealthSaved(false), 3000);
  }

  async function handleTestSpamhaus() {
    setTestingSpamhaus(true);
    setSpamhausTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/spamhaus/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dqs_key: spamhausKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setSpamhausTestResult({ kind: "success" });
      } else {
        setSpamhausTestResult({ kind: "fail", message: data.error ?? "Key check failed" });
      }
    } catch (err) {
      setSpamhausTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Key check failed",
      });
    } finally {
      setTestingSpamhaus(false);
    }
  }

  async function handleTestMillionVerifier() {
    setTestingMillionVerifier(true);
    setMillionVerifierTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/millionverifier/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: millionVerifierKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setMillionVerifierTestResult({ kind: "success", credits: data.credits ?? 0 });
        setMillionVerifierMeta((m) => ({
          ...m,
          credits: typeof data.credits === "number" ? data.credits : m.credits,
          checkedAt: new Date().toISOString(),
          lastError: null,
          lastErrorAt: null,
        }));
      } else {
        setMillionVerifierTestResult({
          kind: "fail",
          message: data.error ?? "Key check failed",
        });
      }
    } catch (err) {
      setMillionVerifierTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Key check failed",
      });
    } finally {
      setTestingMillionVerifier(false);
    }
  }

  async function handleSaveMillionVerifier() {
    if (!organizationId) return;
    setSavingMillionVerifier(true);
    setMillionVerifierSaved(false);
    const supabase = createClient();
    const { error } = await supabase
      .from("organizations")
      .update({
        millionverifier_api_key: millionVerifierKey.trim() || null,
        // Clear stored error state so the send cron retries with the new key.
        millionverifier_last_error: null,
        millionverifier_last_error_kind: null,
        millionverifier_last_error_at: null,
        millionverifier_error_streak: 0,
      })
      .eq("id", organizationId);
    setSavingMillionVerifier(false);
    if (error) {
      // Surface it rather than claiming "Saved": e.g. migration 00069 not
      // applied yet (unknown column) fails the whole update.
      setMillionVerifierError(error.message);
      return;
    }
    setMillionVerifierError(null);
    setMillionVerifierSaved(true);
    setTimeout(() => setMillionVerifierSaved(false), 3000);
    // Refresh the cached credit balance (also validates the key end-to-end).
    if (millionVerifierKey.trim()) void handleTestMillionVerifier();
  }

  async function handleTestFindymail() {
    setTestingFindymail(true);
    setFindymailTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/findymail/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: findymailKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setFindymailTestResult({ kind: "success", credits: data.credits ?? 0 });
        setFindymailMeta((m) => ({
          ...m,
          credits: typeof data.credits === "number" ? data.credits : m.credits,
          checkedAt: new Date().toISOString(),
        }));
      } else {
        setFindymailTestResult({ kind: "fail", message: data.error ?? "Key check failed" });
      }
    } catch (err) {
      setFindymailTestResult({ kind: "fail", message: err instanceof Error ? err.message : "Key check failed" });
    } finally {
      setTestingFindymail(false);
    }
  }

  async function handleSaveFindymail() {
    if (!organizationId) return;
    setSavingFindymail(true);
    setFindymailSaved(false);
    const supabase = createClient();
    const { error } = await supabase
      .from("organizations")
      .update({ findymail_api_key: findymailKey.trim() || null })
      .eq("id", organizationId);
    setSavingFindymail(false);
    if (error) {
      // Surface it rather than claiming "Saved": e.g. migration 00099 not
      // applied yet (unknown column) fails the whole update.
      setFindymailError(error.message);
      return;
    }
    setFindymailError(null);
    setFindymailSaved(true);
    setTimeout(() => setFindymailSaved(false), 3000);
    if (findymailKey.trim()) void handleTestFindymail();
  }

  // One provider's settings body, unchanged from when these were a flat
  // stack of cards. Only the open provider is built, so a provider that
  // fetches its own config does it on open, not on every page load. The
  // card frame is dropped here because the dialog is the frame.
  // Connection state for a grid card. Only reported where this component
  // actually holds the key: the five extracted cards fetch their own config,
  // so they show no pill rather than a guessed one.
  function statusOf(id: string): StatusKey | null {
    const set = (v: string) => v.trim().length > 0;
    switch (id) {
      case "inboxHealth": return set(spamhausKey) ? "connected" : "notset";
      case "nativeEmail": return set(gmailSaEmail) && set(gmailSaKey) ? "connected" : "notset";
      case "resend": return set(resendKey) ? "connected" : "notset";
      case "apify": return set(apifyKey) ? "connected" : "notset";
      case "scrapio": return set(scrapioKey) ? "connected" : "notset";
      case "emailVerify": return set(millionVerifierKey) ? "connected" : "notset";
      case "findymail": return set(findymailKey) ? "connected" : "notset";
      case "unipile": return set(unipileKey) ? "connected" : "notset";
      case "anthropic": return set(anthropicKey) ? "connected" : "notset";
      case "perplexity": return set(perplexityKey) ? "connected" : "optional";
      case "stripe": return "soon";
      default: return null;
    }
  }
  function panelFor(id: string) {
    switch (id) {
      // Inbox health: Spamhaus blocklist key + auto-pause threshold (migration 00061)
      case "inboxHealth":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600">
                <Activity size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Inbox health</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Scores every sending mailbox each hour from DNS, blacklist, bounce,
                  reply, and seed-placement signals. Can take a mailbox offline
                  automatically when it degrades.
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="spamhausKey" className="text-sm font-medium">
                  Spamhaus DQS key
                </Label>
                <Input
                  id="spamhausKey"
                  type="password"
                  value={spamhausKey}
                  onChange={(e) => setSpamhausKey(e.target.value)}
                  placeholder="Spamhaus Data Query Service key"
                />
                <p className="text-[11px] text-muted-foreground">
                  Free key from <span className="font-mono">spamhaus.com</span> → Data
                  Query Service. Used to check sending domains against the domain
                  blocklist. Leave blank to skip the blacklist check.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="offlineThreshold" className="text-sm font-medium">
                  Auto-pause threshold
                </Label>
                <Input
                  id="offlineThreshold"
                  type="number"
                  min={1}
                  max={100}
                  value={offlineThreshold}
                  onChange={(e) => setOfflineThreshold(e.target.value)}
                  placeholder="Leave blank to only alert"
                  className="max-w-[220px]"
                />
                <p className="text-[11px] text-muted-foreground">
                  Pause a mailbox automatically when its score stays below this number
                  for two checks in a row. Leave blank to only alert, and mailboxes are
                  never paused automatically. 50 is a sensible starting point.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="placementInterval" className="text-sm font-medium">
                  Automatic placement tests (days)
                </Label>
                <Input
                  id="placementInterval"
                  type="number"
                  min={1}
                  max={90}
                  value={placementInterval}
                  onChange={(e) => setPlacementInterval(e.target.value)}
                  placeholder="Leave blank for manual only"
                  className="max-w-[220px]"
                />
                <p className="text-[11px] text-muted-foreground">
                  Every this-many days, send a neutral probe from each active mailbox to
                  your seed inboxes (Mailboxes → Seed inboxes) and read back whether it
                  landed in Inbox, Promotions, or Spam. Feeds the Seed placement health
                  signal. 7 is the default; leave blank to run tests only by hand.
                </p>
              </div>
              <div className="flex gap-2 items-center">
                <Button
                  onClick={handleSaveInboxHealth}
                  disabled={savingInboxHealth}
                  style={{ background: "#2E37FE" }}
                >
                  {savingInboxHealth ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestSpamhaus}
                  disabled={testingSpamhaus || !spamhausKey}
                >
                  {testingSpamhaus ? "Testing..." : "Test key"}
                </Button>
                {inboxHealthSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {inboxHealthError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    Save failed: {inboxHealthError}
                  </span>
                </div>
              )}
              {spamhausTestResult?.kind === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Key works. The test domain came back listed as expected.
                  </span>
                </div>
              )}
              {spamhausTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    {spamhausTestResult.message}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Native email: Google service account w/ domain-wide delegation (migration 00056)
      case "nativeEmail":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA4335]">
                <AtSign size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Native Email (Google)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Send directly from client-owned Google Workspace inboxes via a
                  service account with domain-wide delegation. Manage inboxes under
                  Sending → Mailboxes.
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="gmailSaEmail" className="text-sm font-medium">
                  Service account email
                </Label>
                <Input
                  id="gmailSaEmail"
                  value={gmailSaEmail}
                  onChange={(e) => setGmailSaEmail(e.target.value)}
                  placeholder="native-sender@your-project.iam.gserviceaccount.com"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gmailSaKey" className="text-sm font-medium">
                  Service account private key
                </Label>
                <Textarea
                  id="gmailSaKey"
                  value={gmailSaKey}
                  onChange={(e) => setGmailSaKey(e.target.value)}
                  placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
                  rows={4}
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  The <span className="font-mono">private_key</span> field from the
                  service account&apos;s JSON key file. Each sending domain must
                  authorize this account&apos;s client ID for the{" "}
                  <span className="font-mono">gmail.send</span> and{" "}
                  <span className="font-mono">gmail.readonly</span> scopes in Google
                  Admin. See the setup runbook.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleSaveGmail}
                  disabled={savingGmail}
                  style={{ background: "#2E37FE" }}
                >
                  {savingGmail ? "Saving..." : "Save Service Account"}
                </Button>
                {gmailSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        );
      // Email verification: Million Verifier (migration 00069)
      case "emailVerify":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600">
                <MailCheck size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Email verification</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Verifies every recipient just before its first send (Million
                  Verifier). Invalid and disposable addresses are never sent;
                  catch-all and unknown are free. Leave blank to send unverified.
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="millionVerifierKey" className="text-sm font-medium">
                  Million Verifier API key
                </Label>
                <Input
                  id="millionVerifierKey"
                  type="password"
                  value={millionVerifierKey}
                  onChange={(e) => setMillionVerifierKey(e.target.value)}
                  placeholder="Enter your Million Verifier API key"
                />
                <p className="text-[11px] text-muted-foreground">
                  Find your key at{" "}
                  <span className="font-mono">app.millionverifier.com/api</span>. ~1
                  credit per newly-verified address; results are cached for 30 days so
                  follow-ups are free.
                </p>
              </div>
              {(millionVerifierMeta.credits !== null || millionVerifierMeta.checkedAt) && (
                <p className="text-[11px] text-muted-foreground">
                  {millionVerifierMeta.credits !== null
                    ? `${millionVerifierMeta.credits.toLocaleString()} credits remaining`
                    : "Credits unknown"}
                  {millionVerifierMeta.checkedAt
                    ? ` · checked ${new Date(millionVerifierMeta.checkedAt).toLocaleString()}`
                    : ""}
                </p>
              )}
              {millionVerifierMeta.lastError && (
                <p className="text-[11px] text-red-600">
                  Last error: {millionVerifierMeta.lastError}
                  {millionVerifierMeta.lastErrorAt
                    ? ` (${new Date(millionVerifierMeta.lastErrorAt).toLocaleString()})`
                    : ""}
                </p>
              )}
              <div className="flex gap-2 items-center">
                <Button
                  onClick={handleSaveMillionVerifier}
                  disabled={savingMillionVerifier}
                  style={{ background: "#2E37FE" }}
                >
                  {savingMillionVerifier ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestMillionVerifier}
                  disabled={testingMillionVerifier || !millionVerifierKey}
                >
                  {testingMillionVerifier ? "Testing..." : "Test connection"}
                </Button>
                {millionVerifierSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {millionVerifierError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    Save failed: {millionVerifierError}
                  </span>
                </div>
              )}
              {millionVerifierTestResult?.kind === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Connected · {millionVerifierTestResult.credits.toLocaleString()} credits
                    remaining.
                  </span>
                </div>
              )}
              {millionVerifierTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    {millionVerifierTestResult.message}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Findymail: catch-all email validation (migration 00099)
      case "findymail":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
                <MailCheck size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Catch-all email validation (Findymail)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Recovers deliverable emails on catch-all domains that pattern-matching
                  can&apos;t verify. Turn it on per search with the &quot;Validate catch-all
                  emails&quot; toggle. Pay-on-hit (~$0.049/email); with no key the step is skipped.
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="findymailKey" className="text-sm font-medium">
                  Findymail API key
                </Label>
                <Input
                  id="findymailKey"
                  type="password"
                  value={findymailKey}
                  onChange={(e) => setFindymailKey(e.target.value)}
                  placeholder="Enter your Findymail API key"
                />
                <p className="text-[11px] text-muted-foreground">
                  Find your key at <span className="font-mono">app.findymail.com</span>. Charged 1
                  credit only when a deliverable email is found. Misses and risky catch-alls are free.
                </p>
              </div>
              {(findymailMeta.credits !== null || findymailMeta.checkedAt) && (
                <p className="text-[11px] text-muted-foreground">
                  {findymailMeta.credits !== null
                    ? `${findymailMeta.credits.toLocaleString()} credits remaining`
                    : "Credits unknown"}
                  {findymailMeta.checkedAt
                    ? ` · checked ${new Date(findymailMeta.checkedAt).toLocaleString()}`
                    : ""}
                </p>
              )}
              <div className="flex gap-2 items-center">
                <Button onClick={handleSaveFindymail} disabled={savingFindymail} style={{ background: "#2E37FE" }}>
                  {savingFindymail ? "Saving..." : "Save"}
                </Button>
                <Button variant="outline" onClick={handleTestFindymail} disabled={testingFindymail || !findymailKey}>
                  {testingFindymail ? "Testing..." : "Test connection"}
                </Button>
                {findymailSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {findymailError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">Save failed: {findymailError}</span>
                </div>
              )}
              {findymailTestResult?.kind === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Connected · {findymailTestResult.credits.toLocaleString()} credits remaining.
                  </span>
                </div>
              )}
              {findymailTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">{findymailTestResult.message}</span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Scrap.io API Key (Prospecting tab)
      case "scrapio":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500">
                <Search size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Scrap.io</CardTitle>
                <p className="text-xs text-muted-foreground">Lead enrichment for the Prospecting tab</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="scrapioKey" className="text-sm font-medium">API Key</Label>
                <Input
                  id="scrapioKey"
                  type="password"
                  value={scrapioKey}
                  onChange={(e) => setScrapioKey(e.target.value)}
                  placeholder="Enter your Scrap.io API key"
                />
                <p className="text-[11px] text-muted-foreground">
                  Find your key at <span className="font-mono">scrap.io/account/api</span>. Searches consume credits from your Scrap.io plan.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSaveScrapioKey} disabled={savingScrapio} style={{ background: '#2E37FE' }}>
                  {savingScrapio ? "Saving..." : "Save Key"}
                </Button>
                <Button variant="outline" onClick={handleTestScrapio} disabled={testingScrapio || !scrapioKey}>
                  {testingScrapio ? "Testing..." : "Test Connection"}
                </Button>
                {scrapioSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {scrapioTestResult?.kind === "success" && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle size={16} className="text-emerald-500" />
                    <span className="text-sm font-medium text-emerald-700">Connection successful</span>
                  </div>
                  <ScrapioSubscriptionSummary subscription={scrapioTestResult.subscription} />
                </div>
              )}
              {scrapioTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">{scrapioTestResult.message}</span>
                </div>
              )}

              <div className="border-t border-border/60 pt-4 mt-4 space-y-2">
                <p className="text-sm font-medium">Prospecting blacklist</p>
                <p className="text-[11px] text-muted-foreground">
                  Every business pulled by the Prospecting tab is added to a Scrap.io
                  blacklist for this org. Future searches automatically skip those
                  businesses (no credits charged). Reset wipes the list, so only do
                  this when you want to re-pull a region you scraped a long time ago.
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    onClick={handleResetBlacklist}
                    disabled={resettingBlacklist || !scrapioKey}
                    variant="outline"
                    size="sm"
                  >
                    {resettingBlacklist ? "Resetting…" : "Reset blacklist"}
                  </Button>
                  {blacklistResetResult?.kind === "success" && (
                    <span className="text-sm text-emerald-600 flex items-center gap-1">
                      <CheckCircle size={14} />
                      Blacklist reset
                      {blacklistResetResult.note && (
                        <span className="text-muted-foreground ml-1">
                          ({blacklistResetResult.note})
                        </span>
                      )}
                    </span>
                  )}
                  {blacklistResetResult?.kind === "fail" && (
                    <span className="text-sm text-red-600">
                      {blacklistResetResult.message}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      // Apify: Contacts enrichment (migration 00070)
      case "apify":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600">
                <Bot size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Apify</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Powers Contacts &rarr; Enrich (LinkedIn profile &rarr; email, company &rarr; domain, second-pass waterfall)
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="apifyKey" className="text-sm font-medium">API Token</Label>
                <Input
                  id="apifyKey"
                  type="password"
                  value={apifyKey}
                  onChange={(e) => setApifyKey(e.target.value)}
                  placeholder="apify_api_..."
                />
                <p className="text-[11px] text-muted-foreground">
                  Find your token at <span className="font-mono">console.apify.com</span> &rarr; Settings &rarr;
                  Integrations. One token powers every Contacts &rarr; Enrich step; you&apos;re billed per Apify actor run.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSaveApifyKey} disabled={savingApify} style={{ background: "#2E37FE" }}>
                  {savingApify ? "Saving..." : "Save Token"}
                </Button>
                <Button variant="outline" onClick={handleTestApify} disabled={testingApify || !apifyKey}>
                  {testingApify ? "Testing..." : "Test Connection"}
                </Button>
                {apifySaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {apifyTestResult?.kind === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Connection successful
                    {apifyTestResult.username && (
                      <span className="text-emerald-700/70 font-normal"> · {apifyTestResult.username}</span>
                    )}
                    {apifyTestResult.plan && (
                      <span className="text-emerald-700/70 font-normal"> · {apifyTestResult.plan}</span>
                    )}
                  </span>
                </div>
              )}
              {apifyTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">{apifyTestResult.message}</span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Anthropic: decision-maker enrichment Layer 1
      case "anthropic":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500">
                <Sparkles size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Anthropic</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Powers decision-maker extraction in the Prospecting tab
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="anthropicKey" className="text-sm font-medium">
                  API Key
                </Label>
                <Input
                  id="anthropicKey"
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder="sk-ant-..."
                />
                <p className="text-[11px] text-muted-foreground">
                  Find your key at{" "}
                  <span className="font-mono">console.anthropic.com</span>. Roughly
                  $0.003 per business enriched (Claude Haiku 4.5).
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleSaveAnthropic}
                  disabled={savingAnthropic}
                  style={{ background: "#2E37FE" }}
                >
                  {savingAnthropic ? "Saving..." : "Save Key"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestAnthropic}
                  disabled={testingAnthropic || !anthropicKey}
                >
                  {testingAnthropic ? "Testing..." : "Test Connection"}
                </Button>
                {anthropicSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {anthropicTestResult?.kind === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Connection successful{" "}
                    {anthropicTestResult.model && (
                      <span className="text-emerald-700/70 font-normal">
                        · {anthropicTestResult.model}
                      </span>
                    )}
                  </span>
                </div>
              )}
              {anthropicTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    {anthropicTestResult.message}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Perplexity: decision-maker enrichment Layer 2 (optional)
      case "perplexity":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500">
                <Compass size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  Perplexity
                  <Badge
                    variant="secondary"
                    className="bg-slate-100 text-slate-600 border border-slate-200 text-[10px]"
                  >
                    Optional
                  </Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Web-search fallback when a business website doesn&apos;t surface a
                  decision maker
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="perplexityKey" className="text-sm font-medium">
                  API Key
                </Label>
                <Input
                  id="perplexityKey"
                  type="password"
                  value={perplexityKey}
                  onChange={(e) => setPerplexityKey(e.target.value)}
                  placeholder="pplx-..."
                />
                <p className="text-[11px] text-muted-foreground">
                  Find your key at{" "}
                  <span className="font-mono">perplexity.ai/settings/api</span>. If
                  unset, Layer 2 falls back to Claude&apos;s built-in web search
                  (slightly less accurate).
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleSavePerplexity}
                  disabled={savingPerplexity}
                  style={{ background: "#2E37FE" }}
                >
                  {savingPerplexity ? "Saving..." : "Save Key"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestPerplexity}
                  disabled={testingPerplexity || !perplexityKey}
                >
                  {testingPerplexity ? "Testing..." : "Test Connection"}
                </Button>
                {perplexitySaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {perplexityTestResult?.kind === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Connection successful{" "}
                    {perplexityTestResult.model && (
                      <span className="text-emerald-700/70 font-normal">
                        · {perplexityTestResult.model}
                      </span>
                    )}
                  </span>
                </div>
              )}
              {perplexityTestResult?.kind === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    {perplexityTestResult.message}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Unipile: LinkedIn channel (migration 00046)
      case "unipile":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0A66C2]">
                <LinkedinIcon size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Unipile (LinkedIn)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Connects LinkedIn / Sales Navigator accounts for outbound sequences and reply ingestion
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="unipileKey" className="text-sm font-medium">
                    API Key
                  </Label>
                  <Input
                    id="unipileKey"
                    type="password"
                    value={unipileKey}
                    onChange={(e) => setUnipileKey(e.target.value)}
                    placeholder="Unipile workspace API key"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Find at{" "}
                    <span className="font-mono">dashboard.unipile.com</span> →
                    Access Tokens.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="unipileDsn" className="text-sm font-medium">
                    DSN
                  </Label>
                  <Input
                    id="unipileDsn"
                    value={unipileDsn}
                    onChange={(e) => setUnipileDsn(e.target.value)}
                    placeholder="api7.unipile.com:13779"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Workspace host shown next to your API key on the Unipile
                    dashboard.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleSaveUnipile}
                  disabled={savingUnipile}
                  style={{ background: "#2E37FE" }}
                >
                  {savingUnipile ? "Saving..." : "Save Credentials"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTestUnipile}
                  disabled={testingUnipile || !unipileKey || !unipileDsn}
                >
                  {testingUnipile ? "Testing..." : "Test Connection"}
                </Button>
                {unipileSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
              {unipileTestResult === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
                  <CheckCircle size={16} className="text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700">
                    Connection successful
                  </span>
                </div>
              )}
              {unipileTestResult === "fail" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
                  <XCircle size={16} className="text-red-500" />
                  <span className="text-sm font-medium text-red-700">
                    Connection failed. Check the API key and DSN
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        );
      // Resend (Email)
      case "resend":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50">
                <Mail size={16} className="text-emerald-500" />
              </div>
              <div>
                <CardTitle className="text-base">Resend</CardTitle>
                <p className="text-xs text-muted-foreground">Email delivery for KPI reports &amp; notifications</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="resendKey" className="text-sm font-medium">API Key</Label>
                  <Input
                    id="resendKey"
                    type="password"
                    value={resendKey}
                    onChange={(e) => setResendKey(e.target.value)}
                    placeholder="re_xxxxxxxxxx"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="emailFrom" className="text-sm font-medium">From Address</Label>
                  <Input
                    id="emailFrom"
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                    placeholder="LeadStart <reports@yourdomain.com>"
                  />
                  <p className="text-[11px] text-muted-foreground">Use onboarding@resend.dev for testing</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={handleSaveResend} disabled={savingResend} style={{ background: '#2E37FE' }}>
                  {savingResend ? "Saving..." : "Save Email Settings"}
                </Button>
                {resendSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        );
      // Sync Schedule
      case "dataSync":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
                <Clock size={16} className="text-amber-500" />
              </div>
              <div>
                <CardTitle className="text-base">Data Sync Schedule</CardTitle>
                <p className="text-xs text-muted-foreground">Control when campaign analytics are refreshed</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw size={14} className="text-muted-foreground" />
                <p className="text-sm font-medium">Daily Analytics Sync</p>
                <Badge variant="secondary" className="badge-green text-[10px]">Active</Badge>
              </div>

              <div className="space-y-1">
                <Label className="text-sm font-medium">Sync Time</Label>
                <div className="flex items-center gap-2">
                  <Select value={syncHour12} onValueChange={(v) => v && setSyncHour12(v)}>
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOUR_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground text-sm">:</span>
                  <span className="text-sm font-medium w-8">00</span>
                  <Select value={syncAmPm} onValueChange={(v) => v && setSyncAmPm(v)}>
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AMPM_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Badge variant="secondary" className="badge-blue text-[10px] ml-2">
                    Eastern Time (ET)
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">Refreshes analytics for all active campaigns</p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button onClick={handleSaveSchedule} disabled={savingSchedule} style={{ background: '#2E37FE' }}>
                  {savingSchedule ? "Saving..." : "Save Schedule"}
                </Button>
                {scheduleSaved && (
                  <span className="text-sm text-emerald-600 flex items-center gap-1">
                    <CheckCircle size={14} /> Saved
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        );
      // Stripe (Placeholder)
      case "stripe":
        return (
          <Card className="border-0 py-0 shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50">
                <CreditCard size={16} className="text-violet-500" />
              </div>
              <div>
                <CardTitle className="text-base">Stripe</CardTitle>
                <p className="text-xs text-muted-foreground">Billing &amp; subscriptions</p>
              </div>
              <Badge variant="secondary" className="ml-auto bg-gray-100 text-gray-500 border border-gray-200 text-[10px]">Coming Soon</Badge>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border border-dashed border-gray-200 bg-background/50 p-6 text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  Stripe integration for automated billing, invoicing, and payment tracking will be available soon.
                </p>
                <Button disabled variant="outline" className="text-xs">
                  Connect Stripe Account
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      case "apifySpend":
        return <ApifySpendCard />;
      case "waterfall":
        return <WaterfallSettingsCard />;
      case "registrars":
        return <RegistrarSettingsCard />;
      case "msOauth":
        return <MsOauthSettingsCard />;
      case "automations":
        return <AutomationsSettingsCard />;
      default:
        return null;
    }
  }

  const open = openId ? PROVIDERS[openId] : null;

  return (
    <>
      <div className="space-y-8">
        {PROVIDER_GROUPS.map((group) => (
          <section key={group.label} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.ids.map((id) => {
                const p = PROVIDERS[id];
                const Icon = p.icon;
                const state = statusOf(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setOpenId(id)}
                    className="group flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${p.tile}`}>
                        <Icon size={15} className={p.iconClass} />
                      </div>
                      <span className="flex-1 text-sm font-semibold leading-tight">{p.title}</span>
                      <ChevronRight
                        size={15}
                        className="shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary"
                      />
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{p.blurb}</p>
                    {state && (
                      <span className="mt-auto pt-0.5">
                        <Badge variant="secondary" className={STATUS[state].cls}>
                          {STATUS[state].label}
                        </Badge>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <Dialog open={openId !== null} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {/* The panel renders its own heading, so the accessible title is
              visually hidden rather than duplicated. */}
          <DialogHeader className="sr-only">
            <DialogTitle>{open ? open.title : "Integration"}</DialogTitle>
          </DialogHeader>
          {openId && panelFor(openId)}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScrapioSubscriptionSummary({ subscription }: { subscription: Record<string, unknown> }) {
  // Scrap.io's /subscription response shape isn't formally documented.
  // Surface plan + credits when present and skip otherwise so the UI
  // doesn't show "undefined" for an unknown account tier.
  const plan = typeof subscription.plan === "string" ? subscription.plan : null;
  const remaining =
    typeof subscription.credits_remaining === "number"
      ? subscription.credits_remaining
      : typeof subscription.credits === "number"
        ? subscription.credits
        : null;

  if (!plan && remaining === null) return null;

  return (
    <div className="text-xs text-emerald-700/90 flex flex-wrap gap-x-4 gap-y-1 pl-6">
      {plan && (
        <span>
          Plan: <span className="font-medium">{plan}</span>
        </span>
      )}
      {remaining !== null && (
        <span>
          Credits: <span className="font-medium">{remaining.toLocaleString()}</span>
        </span>
      )}
    </div>
  );
}
