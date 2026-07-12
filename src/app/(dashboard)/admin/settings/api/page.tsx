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
import { useUser } from "@/hooks/use-user";
import {
  Key,
  RefreshCw,
  CheckCircle,
  XCircle,
  Zap,
  Clock,
  Mail,
  CreditCard,
  Settings2,
  Webhook,
  Search,
  Sparkles,
  Compass,
  Send,
  Flame,
  ExternalLink,
  AtSign,
  Activity,
} from "lucide-react";
import type { Organization } from "@/types/app";
import { appUrl } from "@/lib/api-url";

// Brand icon — Lucide's brand-icon set was removed upstream, so inline.
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

export default function IntegrationsPage() {
  const { organizationId } = useUser();
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

  // Unipile (LinkedIn channel — migration 00046)
  const [unipileKey, setUnipileKey] = useState("");
  const [unipileDsn, setUnipileDsn] = useState("");
  const [savingUnipile, setSavingUnipile] = useState(false);
  const [unipileSaved, setUnipileSaved] = useState(false);
  const [testingUnipile, setTestingUnipile] = useState(false);
  const [unipileTestResult, setUnipileTestResult] = useState<
    "success" | "fail" | null
  >(null);

  // Salesforge (primary email channel — migration 00049)
  const [salesforgeKey, setSalesforgeKey] = useState("");
  const [salesforgeWorkspaceId, setSalesforgeWorkspaceId] = useState("");
  const [salesforgeProductId, setSalesforgeProductId] = useState("");
  const [salesforgeWorkspaces, setSalesforgeWorkspaces] = useState<
    { id: string; name: string }[]
  >([]);
  const [salesforgeProducts, setSalesforgeProducts] = useState<
    { id: string; name: string }[]
  >([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [savingSalesforge, setSavingSalesforge] = useState(false);
  const [salesforgeSaved, setSalesforgeSaved] = useState(false);
  const [testingSalesforge, setTestingSalesforge] = useState(false);
  const [salesforgeTestResult, setSalesforgeTestResult] = useState<
    { kind: "success"; me?: Record<string, unknown> } | { kind: "fail"; message: string } | null
  >(null);

  // Native email — Google service account w/ domain-wide delegation (migration 00056)
  const [gmailSaEmail, setGmailSaEmail] = useState("");
  const [gmailSaKey, setGmailSaKey] = useState("");
  const [savingGmail, setSavingGmail] = useState(false);
  const [gmailSaved, setGmailSaved] = useState(false);

  // Warmforge (Salesforge's mailbox-warming sister product — migration 00049)
  const [warmforgeKey, setWarmforgeKey] = useState("");
  const [savingWarmforge, setSavingWarmforge] = useState(false);
  const [warmforgeSaved, setWarmforgeSaved] = useState(false);
  const [testingWarmforge, setTestingWarmforge] = useState(false);
  const [warmforgeTestResult, setWarmforgeTestResult] = useState<
    { kind: "success" } | { kind: "fail"; message: string } | null
  >(null);

  // Inbox health (migration 00061): Spamhaus DQS key for domain-blocklist
  // checks + the auto-pause offline threshold (blank = alert-only).
  const [spamhausKey, setSpamhausKey] = useState("");
  const [offlineThreshold, setOfflineThreshold] = useState("");
  const [savingInboxHealth, setSavingInboxHealth] = useState(false);
  const [inboxHealthSaved, setInboxHealthSaved] = useState(false);
  const [testingSpamhaus, setTestingSpamhaus] = useState(false);
  const [spamhausTestResult, setSpamhausTestResult] = useState<
    { kind: "success" } | { kind: "fail"; message: string } | null
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
          // Salesforge + Warmforge (migration 00049). Read through a
          // separate cast since Organization may not yet enumerate them
          // in the compile-time type until app.ts is regenerated.
          const sfOrg = data as {
            salesforge_api_key?: string | null;
            salesforge_workspace_id?: string | null;
            salesforge_default_product_id?: string | null;
            warmforge_api_key?: string | null;
          };
          if (sfOrg.salesforge_api_key) setSalesforgeKey(sfOrg.salesforge_api_key);
          if (sfOrg.salesforge_workspace_id)
            setSalesforgeWorkspaceId(sfOrg.salesforge_workspace_id);
          if (sfOrg.salesforge_default_product_id)
            setSalesforgeProductId(sfOrg.salesforge_default_product_id);
          if (sfOrg.warmforge_api_key) setWarmforgeKey(sfOrg.warmforge_api_key);
          // Inbox health (migration 00061). Separate cast — same reason as above.
          const ihOrg = data as {
            spamhaus_dqs_key?: string | null;
            inbox_health_offline_threshold?: number | null;
          };
          if (ihOrg.spamhaus_dqs_key) setSpamhausKey(ihOrg.spamhaus_dqs_key);
          if (
            ihOrg.inbox_health_offline_threshold !== null &&
            ihOrg.inbox_health_offline_threshold !== undefined
          ) {
            setOfflineThreshold(String(ihOrg.inbox_health_offline_threshold));
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
        "Reset the Scrap.io blacklist for this org? Future searches will be allowed to re-pull every business they've ever fetched — credits WILL be charged again. This is intended for starting fresh on a region you scraped a long time ago.",
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

  async function handleTestSalesforge() {
    setTestingSalesforge(true);
    setSalesforgeTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/salesforge/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: salesforgeKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setSalesforgeTestResult({ kind: "success", me: data.me });
        // Auto-load workspaces on a successful test so the dropdown
        // is ready without a second click.
        await handleLoadWorkspaces();
      } else {
        setSalesforgeTestResult({ kind: "fail", message: data.error ?? "Connection failed" });
      }
    } catch (err) {
      setSalesforgeTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingSalesforge(false);
    }
  }

  async function handleLoadWorkspaces() {
    if (!salesforgeKey) return;
    setLoadingWorkspaces(true);
    try {
      const res = await fetch(appUrl("/api/admin/salesforge/workspaces"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: salesforgeKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setSalesforgeWorkspaces(data.workspaces ?? []);
      }
    } catch (err) {
      console.error("Failed to load Salesforge workspaces:", err);
    } finally {
      setLoadingWorkspaces(false);
    }
  }

  async function handleLoadProducts(workspaceId: string) {
    if (!salesforgeKey || !workspaceId) return;
    setLoadingProducts(true);
    try {
      const res = await fetch(appUrl("/api/admin/salesforge/products"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: salesforgeKey, workspace_id: workspaceId }),
      });
      const data = await res.json();
      if (res.ok) {
        setSalesforgeProducts(data.products ?? []);
      }
    } catch (err) {
      console.error("Failed to load Salesforge products:", err);
    } finally {
      setLoadingProducts(false);
    }
  }

  async function handleSaveSalesforge() {
    if (!organizationId) return;
    setSavingSalesforge(true);
    setSalesforgeSaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        salesforge_api_key: salesforgeKey || null,
        salesforge_workspace_id: salesforgeWorkspaceId || null,
        salesforge_default_product_id: salesforgeProductId || null,
      })
      .eq("id", organizationId);
    setSalesforgeSaved(true);
    setSavingSalesforge(false);
    setTimeout(() => setSalesforgeSaved(false), 3000);
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

  async function handleSaveWarmforge() {
    if (!organizationId) return;
    setSavingWarmforge(true);
    setWarmforgeSaved(false);
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({ warmforge_api_key: warmforgeKey || null })
      .eq("id", organizationId);
    setWarmforgeSaved(true);
    setSavingWarmforge(false);
    setTimeout(() => setWarmforgeSaved(false), 3000);
  }

  async function handleTestWarmforge() {
    setTestingWarmforge(true);
    setWarmforgeTestResult(null);
    try {
      const res = await fetch(appUrl("/api/admin/warmforge/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: warmforgeKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setWarmforgeTestResult({ kind: "success" });
      } else {
        setWarmforgeTestResult({ kind: "fail", message: data.error ?? "Connection failed" });
      }
    } catch (err) {
      setWarmforgeTestResult({
        kind: "fail",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingWarmforge(false);
    }
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
    const supabase = createClient();
    await supabase
      .from("organizations")
      .update({
        spamhaus_dqs_key: spamhausKey.trim() || null,
        inbox_health_offline_threshold: threshold,
      })
      .eq("id", organizationId);
    // Reflect the clamped value back into the field.
    setOfflineThreshold(threshold === null ? "" : String(threshold));
    setInboxHealthSaved(true);
    setSavingInboxHealth(false);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Settings</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Integrations</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Manage API connections, email, and sync schedules
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Salesforge — primary email channel (migration 00049) */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0EA5E9]">
            <Send size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Salesforge</CardTitle>
            <p className="text-xs text-muted-foreground">
              Primary email channel. Pick a workspace and default product after entering your key.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="salesforgeKey" className="text-sm font-medium">
              API Key
            </Label>
            <Input
              id="salesforgeKey"
              type="password"
              value={salesforgeKey}
              onChange={(e) => setSalesforgeKey(e.target.value)}
              placeholder="Salesforge workspace API key"
            />
            <p className="text-[11px] text-muted-foreground">
              Find at <span className="font-mono">app.salesforge.ai</span> →
              Workspace settings → API. The header is sent as the raw key
              (not <span className="font-mono">Bearer</span>-prefixed).
            </p>
          </div>

          {salesforgeWorkspaces.length > 0 && (
            <div className="space-y-1">
              <Label className="text-sm font-medium">Workspace</Label>
              <Select
                value={salesforgeWorkspaceId}
                onValueChange={(v) => {
                  if (!v) return;
                  setSalesforgeWorkspaceId(v);
                  setSalesforgeProductId("");
                  setSalesforgeProducts([]);
                  void handleLoadProducts(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {salesforgeWorkspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {salesforgeProducts.length > 0 && (
            <div className="space-y-1">
              <Label className="text-sm font-medium">Default product</Label>
              <Select
                value={salesforgeProductId}
                onValueChange={(v) => v && setSalesforgeProductId(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a default product" />
                </SelectTrigger>
                <SelectContent>
                  {salesforgeProducts.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-wrap gap-2 items-center">
            <Button
              onClick={handleSaveSalesforge}
              disabled={savingSalesforge}
              style={{ background: "#2E37FE" }}
            >
              {savingSalesforge ? "Saving..." : "Save Salesforge Setup"}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestSalesforge}
              disabled={testingSalesforge || !salesforgeKey}
            >
              {testingSalesforge ? "Testing..." : "Test Connection"}
            </Button>
            {salesforgeWorkspaces.length === 0 && salesforgeKey && (
              <Button
                variant="outline"
                onClick={handleLoadWorkspaces}
                disabled={loadingWorkspaces}
              >
                {loadingWorkspaces ? "Loading..." : "Load Workspaces"}
              </Button>
            )}
            {loadingProducts && (
              <span className="text-xs text-muted-foreground">Loading products…</span>
            )}
            {salesforgeSaved && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle size={14} /> Saved
              </span>
            )}
          </div>

          {salesforgeTestResult?.kind === "success" && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
              <CheckCircle size={16} className="text-emerald-500" />
              <span className="text-sm font-medium text-emerald-700">
                Connection successful
              </span>
            </div>
          )}
          {salesforgeTestResult?.kind === "fail" && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
              <XCircle size={16} className="text-red-500" />
              <span className="text-sm font-medium text-red-700">
                {salesforgeTestResult.message}
              </span>
            </div>
          )}

          {/* Mailbox connect — the one operation Salesforge doesn't expose
              via API (Gmail/Outlook OAuth requires their hosted page).
              Open Salesforge in a new tab; the user navigates to
              Senders & Mailboxes → Connect from there. */}
          <div className="border-t border-border/60 pt-4 mt-4 space-y-2">
            <p className="text-sm font-medium">Connect a sending mailbox</p>
            <p className="text-[11px] text-muted-foreground">
              The OAuth flow for Gmail/Outlook can&apos;t be done via API,
              so this is the one trip back to Salesforge&apos;s dashboard.
              Open Salesforge → Senders &amp; Mailboxes → Connect. The new
              mailbox auto-syncs back into LeadStart within a minute.
            </p>
            <a
              href={(() => {
                const ws = salesforgeWorkspaces.find(
                  (w) => w.id === salesforgeWorkspaceId,
                ) as { slug?: string } | undefined;
                return ws?.slug
                  ? `https://app.salesforge.ai/${ws.slug}/senders`
                  : "https://app.salesforge.ai";
              })()}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-white bg-[#EA580C] hover:bg-[#c2410c] transition-colors"
            >
              Connect mailbox in Salesforge
              <ExternalLink size={14} />
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Warmforge — Salesforge's mailbox-warming sister product (migration 00049) */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA580C]">
            <Flame size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Warmforge</CardTitle>
            <p className="text-xs text-muted-foreground">
              Inbox-warming sister product to Salesforge. Mailboxes auto-sync
              from Salesforge — only the API key is needed here.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="warmforgeKey" className="text-sm font-medium">
              API Key
            </Label>
            <Input
              id="warmforgeKey"
              type="password"
              value={warmforgeKey}
              onChange={(e) => setWarmforgeKey(e.target.value)}
              placeholder="Warmforge API key"
            />
            <p className="text-[11px] text-muted-foreground">
              Find at <span className="font-mono">app.warmforge.ai</span> →
              Settings → API.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <Button
              onClick={handleSaveWarmforge}
              disabled={savingWarmforge}
              style={{ background: "#2E37FE" }}
            >
              {savingWarmforge ? "Saving..." : "Save Key"}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestWarmforge}
              disabled={testingWarmforge || !warmforgeKey}
            >
              {testingWarmforge ? "Testing..." : "Test Connection"}
            </Button>
            {warmforgeSaved && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle size={14} /> Saved
              </span>
            )}
          </div>
          {warmforgeTestResult?.kind === "success" && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
              <CheckCircle size={16} className="text-emerald-500" />
              <span className="text-sm font-medium text-emerald-700">
                Connection successful
              </span>
            </div>
          )}
          {warmforgeTestResult?.kind === "fail" && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
              <XCircle size={16} className="text-red-500" />
              <span className="text-sm font-medium text-red-700">
                {warmforgeTestResult.message}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inbox health — Spamhaus blocklist key + auto-pause threshold (migration 00061) */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600">
            <Activity size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Inbox health</CardTitle>
            <p className="text-xs text-muted-foreground">
              Scores every sending mailbox each hour from DNS, blacklist, bounce,
              and warmup signals. Can take a mailbox offline automatically when it
              degrades.
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
              for two checks in a row. Leave blank to only alert — mailboxes are
              never paused automatically. 50 is a sensible starting point.
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
          {spamhausTestResult?.kind === "success" && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
              <CheckCircle size={16} className="text-emerald-500" />
              <span className="text-sm font-medium text-emerald-700">
                Key works — the test domain came back listed as expected.
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

      {/* Native email — Google service account w/ domain-wide delegation (migration 00056) */}
      <Card className="border-border/50 shadow-sm">
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
              Admin — see the setup runbook.
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

      {/* Scrap.io API Key (Prospecting tab) */}
      <Card className="border-border/50 shadow-sm">
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
              businesses (no credits charged). Reset wipes the list — only do
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

      {/* Anthropic — decision-maker enrichment Layer 1 */}
      <Card className="border-border/50 shadow-sm">
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
                    — {anthropicTestResult.model}
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

      {/* Perplexity — decision-maker enrichment Layer 2 (optional) */}
      <Card className="border-border/50 shadow-sm">
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
                    — {perplexityTestResult.model}
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

      {/* Unipile — LinkedIn channel (migration 00046) */}
      <Card className="border-border/50 shadow-sm">
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
                Connection failed — check the API key and DSN
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resend (Email) */}
      <Card className="border-border/50 shadow-sm">
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

      {/* Sync Schedule */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
            <Clock size={16} className="text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-base">Data Sync Schedule</CardTitle>
            <p className="text-xs text-muted-foreground">Control when campaign analytics are pulled from Salesforge</p>
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
            <p className="text-[11px] text-muted-foreground">Pulls latest campaign data from Salesforge for all active campaigns</p>
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

      {/* Stripe (Placeholder) */}
      <Card className="border-border/50 shadow-sm">
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
    </div>
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
