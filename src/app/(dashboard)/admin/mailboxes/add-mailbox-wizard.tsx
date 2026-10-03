"use client";

// The single "Add" entry point for the Mailboxes tab. One blue button opens a
// chooser with three doors, then walks the guided flow for each:
//   • Sending inboxes: domain (bring-your-own / use-existing / buy) → Workspace
//     → name inboxes (first/last + handle) → review DNS → provision (kicks off
//     the state machine, reveals one-time passwords, embeds the live stepper +
//     DKIM paste from DomainProvisioningDetail). "Use existing" covers both a
//     tracked domain's first setup and adding inboxes to a domain that is
//     already set up (no DNS changes; the Workspace it lives on is locked in).
//   • A domain only: track one you own or buy a fresh one (inboxes later).
//   • Connect an existing inbox: register an address on a Workspace we manage.
// A domain row's "Set up inboxes" / "Add inboxes" button opens this same
// wizard on that domain at the Workspace step (initialDomainId).
// Everything here talks to the real routes; nothing is stubbed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  X,
  Plus,
  Loader2,
  Check,
  Inbox,
  Globe,
  Link2,
  ChevronRight,
  AlertTriangle,
  Info,
  Mail,
  KeyRound,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import {
  MAX_INBOXES_PER_DOMAIN,
  inboxSetupEligibility,
  type InboxSetupEligibility,
} from "@/lib/deliverability/provisioning";
import { GOOGLE_SEAT_USD_PER_MONTH } from "@/lib/deliverability/costs";
import type { DomainLifecycle, SendingDomain } from "@/types/app";
import { DomainProvisioningDetail } from "./domain-provisioning-detail";

type DomainRow = SendingDomain & { mailbox_count: number };
type DomainOption = { domain: DomainRow; verdict: InboxSetupEligibility };
type Door = "chooser" | "inbox" | "domain" | "connect";
type DomainMode = "track" | "existing" | "buy";
type RegistrarId = "porkbun" | "spaceship";
type RegistrarStatus = { has_porkbun: boolean; has_spaceship: boolean } | null;

interface Workspace {
  id: string;
  label: string;
  admin_email: string;
  is_default: boolean;
}
interface InboxSpec {
  first: string;
  last: string;
  local: string;
  touched: boolean;
}
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
interface KickoffResult {
  domain: SendingDomain;
  passwords: { email: string; password: string }[];
  mode: "setup" | "add_inboxes";
}

const STEP_TITLES = ["Domain", "Workspace", "Inboxes", "Review", "Provision"];
const REGISTRARS: { id: RegistrarId; label: string }[] = [
  { id: "porkbun", label: "Porkbun" },
  { id: "spaceship", label: "Spaceship" },
];
const LIFECYCLE_LABEL: Record<DomainLifecycle, string> = {
  provisioning: "Provisioning",
  warming: "Warming",
  active: "Active",
  tired: "Tired",
  resting: "Resting",
  burned: "Burned",
  retired: "Retired",
};

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function usd(n: number | null | undefined): string {
  return n == null ? "-" : `$${n.toFixed(2)}`;
}
function registrarName(id: string): string {
  return REGISTRARS.find((r) => r.id === id)?.label ?? "Manual DNS";
}
function inboxCount(n: number): string {
  return `${n} inbox${n === 1 ? "" : "es"}`;
}
// Google seat estimate at the owner's cost basis (GOOGLE_SEAT_USD_PER_MONTH,
// the flexible-plan rate), in whole dollars.
function seatCost(seats: number, plusDomain: boolean): string {
  return `~$${Math.round(seats * GOOGLE_SEAT_USD_PER_MONTH)}/mo (Google seats)${plusDomain ? " + domain" : ""}`;
}

export function AddMailboxWizard({
  open,
  onOpenChange,
  domains,
  onDone,
  initialDomainId = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  domains: DomainRow[];
  onDone: () => void;
  /** Open straight on this domain at the Workspace step (a domain row's button). */
  initialDomainId?: string | null;
}) {
  const [door, setDoor] = useState<Door>("chooser");
  const [step, setStep] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which registrars actually have API keys saved, so the picker can show
  // connection state instead of silently offering an unconfigured registrar.
  const [registrarStatus, setRegistrarStatus] = useState<{
    has_porkbun: boolean;
    has_spaceship: boolean;
  } | null>(null);
  // Scrollable body ref: when an action sets an error we scroll it into view
  // (the error banner renders at the top, which is off-screen on long steps).
  const bodyRef = useRef<HTMLDivElement>(null);

  // Step 1: domain
  const [domainMode, setDomainMode] = useState<DomainMode>("track");
  const [trackDomain, setTrackDomain] = useState("");
  const [trackRegistrar, setTrackRegistrar] = useState<RegistrarId | "manual">("manual");
  const [existingId, setExistingId] = useState<string | null>(null);
  const [buyDomain, setBuyDomain] = useState("");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [buyRegistrar, setBuyRegistrar] = useState<RegistrarId | null>(null);
  // Optional URL forwarding (Porkbun only): 301-redirect the sending domain to
  // the client's real site so the bare domain never shows a dead parked page.
  const [forwardTo, setForwardTo] = useState("");

  // Step 2: workspace
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsAdding, setWsAdding] = useState(false);
  const [wsLabel, setWsLabel] = useState("");
  const [wsEmail, setWsEmail] = useState("");

  // Step 3: inboxes
  const [inboxes, setInboxes] = useState<InboxSpec[]>([
    { first: "", last: "", local: "", touched: false },
  ]);

  // Step 5: result
  const [result, setResult] = useState<KickoffResult | null>(null);

  // Connect-existing door
  const [cxEmail, setCxEmail] = useState("");
  const [cxName, setCxName] = useState("");
  const [cxCap, setCxCap] = useState("20");

  // Domain-only door
  const [doDone, setDoDone] = useState(false);

  // Every Google domain with its verdict: a first setup, adding inboxes to one
  // that's already set up, or why it can't take inboxes right now (listed
  // greyed out with the reason, never silently hidden).
  const domainOptions: DomainOption[] = domains
    .filter((d) => d.tier === "gmail")
    .map((d) => ({ domain: d, verdict: inboxSetupEligibility(d, d.mailbox_count) }));
  const eligibleDomains = domainOptions.filter((o) => o.verdict.ok).map((o) => o.domain);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/workspaces"));
      if (!res.ok) return;
      const data = await res.json();
      const list: Workspace[] = data.workspaces ?? [];
      setWorkspaces(list);
      setWsId((cur) => cur ?? list.find((w) => w.is_default)?.id ?? list[0]?.id ?? null);
    } catch {
      /* best-effort: the Workspace step surfaces the empty state */
    }
  }, []);

  // Load registrar connection state and default the picker to a connected
  // registrar (so a domain isn't silently tracked as Manual when Porkbun/
  // Spaceship is available, and picking an unconnected one shows a warning).
  const loadRegistrarStatus = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/registrar/settings"), { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { has_porkbun?: boolean; has_spaceship?: boolean };
      const status = { has_porkbun: !!d.has_porkbun, has_spaceship: !!d.has_spaceship };
      setRegistrarStatus(status);
      const preferred: RegistrarId | "manual" = status.has_porkbun
        ? "porkbun"
        : status.has_spaceship
          ? "spaceship"
          : "manual";
      // Only steer the default; never override a manual choice the user made.
      setTrackRegistrar((cur) => (cur === "manual" ? preferred : cur));
    } catch {
      /* best-effort: the picker just won't show connection state */
    }
  }, []);

  // Reset everything each time the modal opens. Opened from a domain's row, it
  // starts on that domain at the Workspace step instead of the chooser.
  useEffect(() => {
    if (!open) return;
    setDoor(initialDomainId ? "inbox" : "chooser");
    setStep(initialDomainId ? 2 : 1);
    setErr(null);
    setBusy(false);
    setDomainMode(initialDomainId ? "existing" : "track");
    setTrackDomain("");
    setTrackRegistrar("manual");
    setExistingId(initialDomainId);
    setBuyDomain("");
    setQuote(null);
    setBuyRegistrar(null);
    setForwardTo("");
    setInboxes([{ first: "", last: "", local: "", touched: false }]);
    setResult(null);
    setCxEmail("");
    setCxName("");
    setCxCap("20");
    setDoDone(false);
    setRegistrarStatus(null);
    void loadWorkspaces();
    void loadRegistrarStatus();
  }, [open, initialDomainId, loadWorkspaces, loadRegistrarStatus]);

  // Bring a freshly-set error into view (it renders at the top of the scroll).
  useEffect(() => {
    if (err) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [err]);

  if (!open) return null;

  // ── derived: the domain name + registrar the flow is targeting ──
  const existingDomain = eligibleDomains.find((d) => d.id === existingId) ?? null;
  const existingVerdict = existingDomain
    ? inboxSetupEligibility(existingDomain, existingDomain.mailbox_count)
    : null;
  // Adding inboxes to a domain that's already set up (vs. its first setup).
  const addingToExisting =
    domainMode === "existing" && existingVerdict?.ok === true && existingVerdict.mode === "add_inboxes";
  // Inboxes the picked domain already holds: the per-domain cap counts them.
  const existingInboxCount = domainMode === "existing" ? existingDomain?.mailbox_count ?? 0 : 0;
  const inboxSlots = MAX_INBOXES_PER_DOMAIN - existingInboxCount;
  // A domain set up through LeadStart stays on its Workspace: new inboxes go there.
  const lockedWsId = addingToExisting ? existingDomain?.workspace_id ?? null : null;
  const effectiveWsId = lockedWsId ?? wsId;
  // "Bring my own" typed a domain LeadStart already tracks: steer to Use existing.
  const trackedMatch =
    domainMode === "track"
      ? domains.find((d) => d.domain === trackDomain.trim().toLowerCase()) ?? null
      : null;
  const targetDomainName =
    domainMode === "existing"
      ? existingDomain?.domain ?? ""
      : domainMode === "track"
        ? trackDomain.trim().toLowerCase()
        : buyDomain.trim().toLowerCase();
  const targetRegistrar: RegistrarId | "manual" =
    domainMode === "existing"
      ? (existingDomain?.registrar as RegistrarId | "manual") ?? "manual"
      : domainMode === "track"
        ? trackRegistrar
        : buyRegistrar ?? "manual";
  const registrarConnected = (id: RegistrarId | "manual"): boolean =>
    id === "manual"
      ? true
      : id === "porkbun"
        ? !!registrarStatus?.has_porkbun
        : !!registrarStatus?.has_spaceship;
  // A non-manual registrar only auto-writes DNS when its API key is actually
  // saved. Picking Porkbun/Spaceship without a key is the trap that leaves the
  // verification TXT unwritten and stalls setup at "Verify domain ownership".
  const autoDns = targetRegistrar !== "manual" && registrarConnected(targetRegistrar);
  const registrarMissingKey = targetRegistrar !== "manual" && !registrarConnected(targetRegistrar);
  // URL forwarding is Porkbun-only (Spaceship has no forwarding API).
  const forwardingSupported = targetRegistrar === "porkbun" && registrarConnected("porkbun");
  const namedInboxes = inboxes.filter((i) => slug(i.local));

  // ── step 1 gating ──
  const step1Ready =
    domainMode === "existing"
      ? !!existingDomain
      : domainMode === "track"
        ? /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(trackDomain.trim().toLowerCase()) && !trackedMatch
        : !!buyRegistrar && !!buyDomain.trim();

  function close() {
    onOpenChange(false);
  }

  function pickExisting(id: string) {
    setDomainMode("existing");
    setExistingId(id);
    setErr(null);
  }

  // Next. Leaving the Workspace step on an existing domain runs the server's
  // preflight (eligibility + a live "is the domain on this Workspace" check),
  // so a domain that can't take inboxes there fails before any naming.
  async function goNext() {
    setErr(null);
    // Switching to a domain that already has inboxes can leave more names than
    // it has room for: stop here rather than fail at Create.
    if (door === "inbox" && step === 3 && namedInboxes.length > inboxSlots) {
      setErr(
        `${targetDomainName} can take ${inboxSlots} more inbox${inboxSlots === 1 ? "" : "es"} ` +
          `(a domain holds at most ${MAX_INBOXES_PER_DOMAIN}). Remove ${namedInboxes.length - inboxSlots}.`,
      );
      return;
    }
    if (door === "inbox" && step === 2 && domainMode === "existing" && existingDomain) {
      setBusy(true);
      try {
        const qs = effectiveWsId ? `?workspace_id=${encodeURIComponent(effectiveWsId)}` : "";
        const res = await fetch(appUrl(`/api/admin/domains/${existingDomain.id}/workspace${qs}`), {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          setErr(data.reason ?? data.error ?? "This domain can't take new inboxes right now.");
          return;
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setBusy(false);
      }
    }
    setStep(step + 1);
  }

  function editInbox(i: number, key: "first" | "last" | "local", v: string) {
    setInboxes((prev) => {
      const next = prev.map((x) => ({ ...x }));
      next[i][key] = v;
      if (key === "local") next[i].touched = true;
      if (key === "first" && !next[i].touched) next[i].local = slug(v);
      return next;
    });
  }
  function addInbox() {
    // The hard cap counts the inboxes the domain already has.
    setInboxes((prev) =>
      prev.length >= inboxSlots ? prev : [...prev, { first: "", last: "", local: "", touched: false }],
    );
  }
  function removeInbox(i: number) {
    setInboxes((prev) => prev.filter((_, j) => j !== i));
  }

  async function runQuote() {
    const d = buyDomain.trim().toLowerCase();
    if (!d) return;
    setQuoting(true);
    setErr(null);
    setQuote(null);
    setBuyRegistrar(null);
    try {
      const res = await fetch(appUrl("/api/admin/registrar/quote"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not price that domain.");
        return;
      }
      setQuote(data as QuoteResult);
      const cheapest = (data.quotes as Quote[])
        .filter((q) => q.available)
        .sort((a, b) => (a.price_usd ?? Infinity) - (b.price_usd ?? Infinity))[0];
      setBuyRegistrar(cheapest?.registrar ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQuoting(false);
    }
  }

  async function addWorkspace() {
    if (!wsLabel.trim() || !wsEmail.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(appUrl("/api/admin/workspaces"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: wsLabel.trim(), admin_email: wsEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not add that Workspace.");
        return;
      }
      await loadWorkspaces();
      setWsId(data.workspace?.id ?? null);
      setWsAdding(false);
      setWsLabel("");
      setWsEmail("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Create the domain row (if needed) then kick off Workspace provisioning.
  async function createInboxes() {
    if (namedInboxes.length === 0) {
      setErr("Name at least one inbox.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let domainRow: SendingDomain;
      if (domainMode === "existing") {
        if (!existingDomain) {
          setErr("Pick a domain.");
          return;
        }
        domainRow = existingDomain;
      } else if (domainMode === "track") {
        const res = await fetch(appUrl("/api/admin/domains"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: targetDomainName,
            registrar: trackRegistrar,
            workspace_id: effectiveWsId,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error ?? "Could not track that domain.");
          return;
        }
        domainRow = data.domain as SendingDomain;
      } else {
        // buy: spends real money; gated behind registrar keys + spend cap.
        const res = await fetch(appUrl("/api/admin/registrar/provision"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: targetDomainName, registrar: buyRegistrar }),
        });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error ?? "Purchase failed.");
          return;
        }
        domainRow = data.domain as SendingDomain;
      }

      const users = namedInboxes.map((i) => ({
        local_part: slug(i.local),
        given_name: i.first.trim(),
        family_name: i.last.trim(),
      }));
      const res2 = await fetch(appUrl(`/api/admin/domains/${domainRow.id}/workspace`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users, workspace_id: effectiveWsId }),
      });
      const data2 = await res2.json();
      if (!res2.ok) {
        setErr(data2.error ?? "Setup could not start.");
        return;
      }

      // Optional URL forwarding (Porkbun only). Best-effort: a forwarding hiccup
      // must not fail the setup: it can always be set later from the domain row.
      if (forwardingSupported && forwardTo.trim()) {
        try {
          await fetch(appUrl("/api/admin/registrar/forward"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domain: domainRow.domain, destinationUrl: forwardTo.trim() }),
          });
        } catch {
          /* non-fatal */
        }
      }

      setResult({
        domain: {
          ...domainRow,
          provisioning: data2.provisioning,
          workspace_id: effectiveWsId ?? domainRow.workspace_id,
        },
        passwords: Array.isArray(data2.revealed_passwords) ? data2.revealed_passwords : [],
        mode: data2.mode === "add_inboxes" ? "add_inboxes" : "setup",
      });
      onDone();
      setStep(5);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function trackDomainOnly() {
    const d = trackDomain.trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) {
      setErr("Enter a valid domain (e.g. mail.acme.com).");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(appUrl("/api/admin/domains"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d, registrar: trackRegistrar }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not track that domain.");
        return;
      }
      onDone();
      setDoDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectInbox() {
    const email = cxEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setErr("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(appUrl("/api/admin/mailboxes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email_address: email,
          display_name: cxName.trim() || undefined,
          max_daily_cap: Number(cxCap) || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not connect that inbox.");
        return;
      }
      onDone();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── header ──
  const headerIcon =
    door === "inbox" ? <Mail size={16} /> : door === "domain" ? <Globe size={16} /> : door === "connect" ? <Link2 size={16} /> : <Plus size={16} />;
  // Once a run starts, the result decides: the page refresh after Create marks
  // the domain mid-run, which would otherwise flip this back to "Set up".
  const addingInboxes = result ? result.mode === "add_inboxes" : addingToExisting;
  const headerTitle =
    door === "chooser"
      ? "Add to Mailboxes"
      : door === "inbox"
        ? addingInboxes
          ? "Add inboxes"
          : "Set up inboxes"
        : door === "domain"
          ? "Add a domain"
          : "Connect an inbox";
  const headerSub =
    door === "inbox" ? `Step ${step} of 5 · ${STEP_TITLES[step - 1]}` : null;

  const showStepBar = door === "inbox";
  const showFooter = door !== "chooser" && !(door === "domain" && doDone);
  const onFinalStep = door === "inbox" && step === 5;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="flex h-[600px] max-h-[90vh] w-[600px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-border/60 p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            {headerIcon}
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight">{headerTitle}</h2>
            {headerSub && <p className="font-mono text-xs text-muted-foreground">{headerSub}</p>}
          </div>
          <button
            onClick={close}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground hover:bg-muted/70"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* step bar */}
        {showStepBar && (
          <div className="flex gap-2 px-4 pt-3.5">
            {STEP_TITLES.map((t, i) => {
              const n = i + 1;
              const active = n === step;
              const done = n < step;
              return (
                <div
                  key={t}
                  className="flex-1 text-center text-[10.5px] font-semibold uppercase tracking-wide"
                  style={{ color: active ? "var(--primary)" : "var(--muted-foreground)" }}
                >
                  <div
                    className="mb-1.5 h-[3px] rounded"
                    style={{ background: active || done ? "var(--primary)" : "var(--border)" }}
                  />
                  {t}
                </div>
              );
            })}
          </div>
        )}

        {/* body */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto p-4">
          {err && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">
              {err}
            </div>
          )}

          {door === "chooser" && <Chooser onPick={(d) => { setDoor(d); setStep(1); setErr(null); }} />}

          {door === "inbox" && step === 1 && (
            <DomainStep
              mode={domainMode}
              setMode={(m) => { setDomainMode(m); setErr(null); }}
              trackDomain={trackDomain}
              setTrackDomain={setTrackDomain}
              trackRegistrar={trackRegistrar}
              setTrackRegistrar={setTrackRegistrar}
              registrarStatus={registrarStatus}
              domainOptions={domainOptions}
              existingId={existingId}
              setExistingId={setExistingId}
              trackedMatch={trackedMatch}
              pickExisting={pickExisting}
              buyDomain={buyDomain}
              setBuyDomain={setBuyDomain}
              quote={quote}
              quoting={quoting}
              runQuote={runQuote}
              buyRegistrar={buyRegistrar}
              setBuyRegistrar={setBuyRegistrar}
            />
          )}

          {door === "inbox" && step === 2 && (
            <WorkspaceStep
              workspaces={workspaces}
              wsId={effectiveWsId}
              setWsId={setWsId}
              lockedFor={lockedWsId ? existingDomain?.domain ?? null : null}
              adding={wsAdding}
              setAdding={setWsAdding}
              label={wsLabel}
              setLabel={setWsLabel}
              email={wsEmail}
              setEmail={setWsEmail}
              addWorkspace={addWorkspace}
              busy={busy}
            />
          )}

          {door === "inbox" && step === 3 && (
            <InboxesStep
              inboxes={inboxes}
              domain={targetDomainName || "your-domain.com"}
              existingCount={existingInboxCount}
              editInbox={editInbox}
              addInbox={addInbox}
              removeInbox={removeInbox}
            />
          )}

          {door === "inbox" && step === 4 && (
            <ReviewStep
              domain={targetDomainName}
              registrar={targetRegistrar}
              autoDns={autoDns}
              registrarMissingKey={registrarMissingKey}
              forwardingSupported={forwardingSupported}
              forwardTo={forwardTo}
              setForwardTo={setForwardTo}
              workspaceLabel={workspaces.find((w) => w.id === effectiveWsId)?.label ?? "default Workspace"}
              inboxes={namedInboxes}
              mode={domainMode}
              addingToExisting={addingToExisting}
              existingCount={existingInboxCount}
              awaitingDkim={addingToExisting && existingDomain?.lifecycle_status === "provisioning"}
            />
          )}

          {door === "inbox" && step === 5 && result && (
            <ProvisionStep result={result} onDone={onDone} />
          )}

          {door === "domain" && !doDone && (
            <DomainOnlyStep
              trackDomain={trackDomain}
              setTrackDomain={setTrackDomain}
              trackRegistrar={trackRegistrar}
              setTrackRegistrar={setTrackRegistrar}
              registrarStatus={registrarStatus}
            />
          )}
          {door === "domain" && doDone && (
            <div className="pt-2 text-center">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full border-2 border-emerald-200 bg-emerald-50 text-emerald-600">
                <Check size={26} />
              </div>
              <h3 className="text-base font-semibold">Domain tracked</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {trackDomain.trim().toLowerCase()} is now in <b>provisioning</b> with no inboxes. Use{" "}
                <b>Set up inboxes</b> on its row whenever you&rsquo;re ready.
              </p>
              <Button className="mt-5" onClick={close}>Done</Button>
            </div>
          )}

          {door === "connect" && (
            <ConnectStep
              email={cxEmail}
              setEmail={setCxEmail}
              name={cxName}
              setName={setCxName}
              cap={cxCap}
              setCap={setCxCap}
            />
          )}
        </div>

        {/* footer */}
        {showFooter && (
          <div className="flex items-center gap-2 border-t border-border/60 bg-muted/30 p-3.5">
            {!onFinalStep && (
              <Button
                variant="ghost"
                onClick={() => {
                  setErr(null);
                  if (door === "inbox" && step > 1) setStep(step - 1);
                  else { setDoor("chooser"); setStep(1); }
                }}
              >
                Back
              </Button>
            )}
            <span className="flex-1" />
            {onFinalStep && <Button onClick={close}>Done</Button>}
            {door === "inbox" && step < 4 && (
              <Button onClick={goNext} disabled={busy || (step === 1 && !step1Ready)}>
                {busy && step === 2 ? <Loader2 size={15} className="animate-spin" /> : "Next"}
              </Button>
            )}
            {door === "inbox" && step === 4 && (
              <Button onClick={createInboxes} disabled={busy || namedInboxes.length === 0}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : "Create inboxes"}
              </Button>
            )}
            {door === "domain" && (
              <Button onClick={trackDomainOnly} disabled={busy || !trackDomain.trim()}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : "Track domain"}
              </Button>
            )}
            {door === "connect" && (
              <Button onClick={connectInbox} disabled={busy || !cxEmail.trim()}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : "Connect inbox"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-views

function Chooser({ onPick }: { onPick: (d: Door) => void }) {
  const doors: { id: Door; icon: ReactNode; iconCls: string; title: string; desc: string; badge?: string }[] = [
    {
      id: "inbox",
      icon: <Inbox size={20} />,
      iconCls: "bg-primary/10 text-primary",
      title: "Sending inboxes",
      desc: "Spin up Google inboxes on a new domain or one you already have, ready to warm up. Walks the full setup.",
      badge: "Most common",
    },
    {
      id: "domain",
      icon: <Globe size={20} />,
      iconCls: "bg-sky-50 text-sky-600",
      title: "A domain only",
      desc: "Buy a fresh sending domain or track one you already own. Set up its inboxes later.",
    },
    {
      id: "connect",
      icon: <Link2 size={20} />,
      iconCls: "bg-violet-50 text-violet-600",
      title: "Connect an existing inbox",
      desc: "Already send from a mailbox on a Workspace we manage? Register it to use in campaigns.",
    },
  ];
  return (
    <div>
      <h3 className="text-[15px] font-semibold">What do you want to add?</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Inboxes live inside a domain, and a domain lives on a Google Workspace, so most of the time you
        want the first one.
      </p>
      {doors.map((d) => (
        <button
          key={d.id}
          onClick={() => onPick(d.id)}
          className="mb-2.5 flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition hover:border-primary/40 hover:bg-primary/[0.02]"
        >
          <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-lg ${d.iconCls}`}>
            {d.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[14.5px] font-semibold">
              {d.title}
              {d.badge && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                  {d.badge}
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{d.desc}</span>
          </span>
          <ChevronRight size={18} className="mt-2 flex-none text-muted-foreground/60" />
        </button>
      ))}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="mb-3.5 flex gap-1 rounded-xl bg-muted p-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition ${
            value === o.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Shared "Where its DNS lives" picker. Shows whether each registrar is actually
// connected and warns when the chosen one isn't (the trap that silently tracks a
// domain the flow can't write DNS for).
function RegistrarPicker({
  value,
  onChange,
  status,
}: {
  value: RegistrarId | "manual";
  onChange: (v: RegistrarId | "manual") => void;
  status: RegistrarStatus;
}) {
  const pkOn = !!status?.has_porkbun;
  const ssOn = !!status?.has_spaceship;
  const missing = value !== "manual" && !(value === "porkbun" ? pkOn : ssOn);
  const label = value === "porkbun" ? "Porkbun" : "Spaceship";
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Where its DNS lives</Label>
        <select
          className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value as RegistrarId | "manual")}
        >
          <option value="porkbun">
            {pkOn ? "Porkbun: auto-writes DNS" : "Porkbun: not connected (add key in Settings)"}
          </option>
          <option value="spaceship">
            {ssOn ? "Spaceship: auto-writes DNS" : "Spaceship: not connected (add key in Settings)"}
          </option>
          <option value="manual">Manual: you&rsquo;ll add the records by hand</option>
        </select>
      </div>
      {missing ? (
        <Callout kind="warn">
          <b>{label} isn&rsquo;t connected.</b> Add its API key under Settings, API, or LeadStart can&rsquo;t
          write this domain&rsquo;s DNS and setup stalls at &ldquo;Verify domain ownership.&rdquo; Or pick
          Manual and paste the records yourself.
        </Callout>
      ) : (
        <Callout kind="info">
          Zero spend, and the proven path. On a connected registrar we lay down the DNS for you; on Manual we
          hand you the records to paste.
        </Callout>
      )}
    </div>
  );
}

function DomainStep(props: {
  mode: DomainMode;
  setMode: (m: DomainMode) => void;
  trackDomain: string;
  setTrackDomain: (v: string) => void;
  trackRegistrar: RegistrarId | "manual";
  setTrackRegistrar: (v: RegistrarId | "manual") => void;
  registrarStatus: RegistrarStatus;
  domainOptions: DomainOption[];
  existingId: string | null;
  setExistingId: (v: string) => void;
  trackedMatch: DomainRow | null;
  pickExisting: (id: string) => void;
  buyDomain: string;
  setBuyDomain: (v: string) => void;
  quote: QuoteResult | null;
  quoting: boolean;
  runQuote: () => void;
  buyRegistrar: RegistrarId | null;
  setBuyRegistrar: (v: RegistrarId) => void;
}) {
  const ready = props.domainOptions.filter((o) => o.verdict.ok);
  const blocked = props.domainOptions.filter((o) => !o.verdict.ok);
  const matchVerdict = props.trackedMatch
    ? inboxSetupEligibility(props.trackedMatch, props.trackedMatch.mailbox_count)
    : null;
  const best = (props.quote?.quotes ?? [])
    .filter((q) => q.available)
    .slice()
    .sort((a, b) => (a.price_usd ?? Infinity) - (b.price_usd ?? Infinity))[0];
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Which domain will these inboxes live on?</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Cold outreach uses a separate domain from your real one, so a spam hit never touches your main mail.
      </p>
      <Segmented
        value={props.mode}
        onChange={props.setMode}
        options={[
          { id: "track", label: "Bring my own" },
          { id: "existing", label: "Use existing" },
          { id: "buy", label: "Buy new" },
        ]}
      />

      {props.mode === "track" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Domain you already own</Label>
            <Input
              className="mt-1 font-mono text-sm"
              placeholder="mail.acme.com"
              value={props.trackDomain}
              onChange={(e) => props.setTrackDomain(e.target.value)}
            />
          </div>
          {props.trackedMatch ? (
            <Callout kind="warn">
              <b>{props.trackedMatch.domain} is already in LeadStart</b> ({inboxCount(props.trackedMatch.mailbox_count)},{" "}
              {LIFECYCLE_LABEL[props.trackedMatch.lifecycle_status].toLowerCase()}).{" "}
              {matchVerdict?.ok ? (
                <button
                  className="font-semibold underline underline-offset-2"
                  onClick={() => props.pickExisting(props.trackedMatch!.id)}
                >
                  {matchVerdict.mode === "add_inboxes" ? "Add inboxes to it" : "Set up its inboxes"}
                </button>
              ) : (
                matchVerdict?.reason
              )}
            </Callout>
          ) : (
            <RegistrarPicker
              value={props.trackRegistrar}
              onChange={props.setTrackRegistrar}
              status={props.registrarStatus}
            />
          )}
        </div>
      )}

      {props.mode === "existing" && (
        <div className="space-y-2">
          <Label className="text-xs">Pick a domain</Label>
          {props.domainOptions.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              No Google domains in LeadStart yet. Bring your own or buy a new one.
            </p>
          ) : (
            <>
              {ready.length === 0 && (
                <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  None of your domains can take new inboxes right now. Each one says why below.
                </p>
              )}
              {ready.map(({ domain: d, verdict }) => (
                <button
                  key={d.id}
                  onClick={() => props.setExistingId(d.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left ${
                    props.existingId === d.id ? "border-primary bg-primary/5" : "border-border hover:border-border/70"
                  }`}
                >
                  <span
                    className={`h-4 w-4 flex-none rounded-full border-2 ${
                      props.existingId === d.id ? "border-primary bg-primary ring-2 ring-inset ring-white" : "border-slate-300"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] font-medium">{d.domain}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {registrarName(d.registrar)} ·{" "}
                      {verdict.ok && verdict.mode === "setup"
                        ? "awaiting inbox setup"
                        : `${LIFECYCLE_LABEL[d.lifecycle_status]} · ${inboxCount(d.mailbox_count)} · add more`}
                    </span>
                  </span>
                </button>
              ))}
              {blocked.map(({ domain: d, verdict }) => (
                <div
                  key={d.id}
                  className="flex w-full items-start gap-2.5 rounded-lg border border-dashed border-border p-2.5 opacity-70"
                >
                  <span className="mt-0.5 h-4 w-4 flex-none rounded-full border-2 border-slate-200" />
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] font-medium">{d.domain}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {LIFECYCLE_LABEL[d.lifecycle_status]} · {verdict.ok ? "" : verdict.reason}
                    </span>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {props.mode === "buy" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Buy a fresh domain</Label>
            <div className="mt-1 flex gap-2">
              <Input
                className="flex-1 font-mono text-sm"
                placeholder="tryacme.com"
                value={props.buyDomain}
                onChange={(e) => props.setBuyDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && props.runQuote()}
              />
              <Button variant="outline" onClick={props.runQuote} disabled={props.quoting || !props.buyDomain.trim()}>
                {props.quoting ? <Loader2 size={14} className="animate-spin" /> : "Check price"}
              </Button>
            </div>
          </div>
          {props.quote && (
            <div className="grid grid-cols-2 gap-2">
              {REGISTRARS.map((r) => {
                const q = props.quote!.quotes.find((x) => x.registrar === r.id);
                const selectable = !!q?.available;
                const isBest = best?.registrar === r.id;
                const sel = props.buyRegistrar === r.id;
                return (
                  <button
                    key={r.id}
                    disabled={!selectable}
                    onClick={() => selectable && props.setBuyRegistrar(r.id)}
                    className={`rounded-xl border p-3 text-left transition ${
                      sel
                        ? "border-primary bg-primary/5 ring-2 ring-primary/15"
                        : selectable
                          ? "border-border hover:border-primary/40"
                          : "border-border/50 bg-muted/30 opacity-60"
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
                    <div className="mt-1 text-lg font-bold tabular-nums">{selectable ? usd(q?.price_usd) : "-"}</div>
                    <div className="text-[11px] text-muted-foreground">{selectable ? "available · first year" : "unavailable"}</div>
                  </button>
                );
              })}
            </div>
          )}
          <Callout kind="warn">
            <b>Spends real money.</b> The purchase is gated behind registrar keys + a monthly spend cap.
            Plus ~${GOOGLE_SEAT_USD_PER_MONTH.toFixed(2)}/mo per Google seat once inboxes are created.
          </Callout>
        </div>
      )}
    </div>
  );
}

function WorkspaceStep(props: {
  workspaces: Workspace[];
  wsId: string | null;
  setWsId: (v: string) => void;
  /** The domain already lives on wsId: new inboxes must go there too. */
  lockedFor: string | null;
  adding: boolean;
  setAdding: (v: boolean) => void;
  label: string;
  setLabel: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  addWorkspace: () => void;
  busy: boolean;
}) {
  const shown = props.lockedFor ? props.workspaces.filter((w) => w.id === props.wsId) : props.workspaces;
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Which Google Workspace should host it?</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        {props.lockedFor ? (
          <>
            <span className="font-mono">{props.lockedFor}</span> is already set up on this Workspace, so the new
            inboxes are created there.
          </>
        ) : (
          "Every inbox sends through one service account that impersonates the address, so what matters is that the Workspace has authorized that service account."
        )}
      </p>
      <div className="space-y-2">
        {shown.map((w) => (
          <button
            key={w.id}
            onClick={() => props.setWsId(w.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left ${
              props.wsId === w.id ? "border-primary bg-primary/5" : "border-border hover:border-border/70"
            }`}
          >
            <span
              className={`h-4 w-4 flex-none rounded-full border-2 ${
                props.wsId === w.id ? "border-primary bg-primary ring-2 ring-inset ring-white" : "border-slate-300"
              }`}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-[13px] font-medium">
                {w.label}
                {w.is_default && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">default</span>
                )}
              </span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">{w.admin_email}</span>
            </span>
          </button>
        ))}
        {props.workspaces.length === 0 && !props.lockedFor && (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            No Workspaces yet. Add one below: its admin still needs to authorize the service account&rsquo;s
            client ID in Google Admin before provisioning can run.
          </p>
        )}
      </div>

      {props.lockedFor ? null : props.adding ? (
        <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
          <Label className="text-xs">Name it</Label>
          <Input placeholder="e.g. Acme Outreach" value={props.label} onChange={(e) => props.setLabel(e.target.value)} />
          <Label className="text-xs">Workspace super-admin email</Label>
          <Input
            placeholder="admin@acme.com"
            value={props.email}
            onChange={(e) => props.setEmail(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={props.addWorkspace} disabled={props.busy || !props.label.trim() || !props.email.trim()}>
              {props.busy ? <Loader2 size={13} className="animate-spin" /> : "Add Workspace"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => props.setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => props.setAdding(true)}>
          <Plus size={13} /> Add a different Workspace
        </Button>
      )}
    </div>
  );
}

function InboxesStep(props: {
  inboxes: InboxSpec[];
  domain: string;
  /** Inboxes the domain already has (adding to an existing domain), else 0. */
  existingCount: number;
  editInbox: (i: number, key: "first" | "last" | "local", v: string) => void;
  addInbox: () => void;
  removeInbox: (i: number) => void;
}) {
  const n = props.inboxes.length;
  // Deliverability guidance is per domain, so it counts the inboxes already there.
  const total = n + props.existingCount;
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Name the inboxes</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Google creates each user with a real first &amp; last name: that&rsquo;s the From name recipients
        see. The mailbox handle is auto-suggested from the first name; edit it freely. Avoid role addresses
        like <span className="font-mono">info@</span>.
        {props.existingCount > 0 && (
          <>
            {" "}
            <span className="font-mono">{props.domain}</span> already has {inboxCount(props.existingCount)}.
          </>
        )}
      </p>
      {props.inboxes.map((ib, i) => (
        <div key={i} className="mb-2.5 rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center justify-between text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
            <span>Inbox {i + 1}</span>
            {n > 1 && (
              <button
                onClick={() => props.removeInbox(i)}
                className="rounded p-0.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                aria-label="remove inbox"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">First name</Label>
              <Input className="mt-1" placeholder="Jane" value={ib.first} onChange={(e) => props.editInbox(i, "first", e.target.value)} />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Last name</Label>
              <Input className="mt-1" placeholder="Rivera" value={ib.last} onChange={(e) => props.editInbox(i, "last", e.target.value)} />
            </div>
          </div>
          <div className="mt-2">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Mailbox address</Label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                className="flex-1 font-mono text-sm"
                placeholder="jane"
                value={ib.local}
                onChange={(e) => props.editInbox(i, "local", e.target.value)}
              />
              <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">@{props.domain}</span>
            </div>
          </div>
        </div>
      ))}
      {total < MAX_INBOXES_PER_DOMAIN && (
        <button className="text-xs font-semibold text-primary hover:underline" onClick={props.addInbox}>
          + Add inbox
        </button>
      )}
      {total > MAX_INBOXES_PER_DOMAIN ? (
        <Callout kind="warn" className="mt-2.5">
          <b>
            {total} inboxes on one domain{props.existingCount > 0 ? ` (${props.existingCount} already there)` : ""}.
          </b>{" "}
          A domain holds at most {MAX_INBOXES_PER_DOMAIN}: remove {total - MAX_INBOXES_PER_DOMAIN} to continue.
        </Callout>
      ) : (
        <p className="mt-2.5 text-xs text-muted-foreground">
          A domain holds at most {MAX_INBOXES_PER_DOMAIN} inboxes. Need more? Add another domain.
        </p>
      )}
    </div>
  );
}

function ReviewStep(props: {
  domain: string;
  registrar: RegistrarId | "manual";
  autoDns: boolean;
  registrarMissingKey: boolean;
  forwardingSupported: boolean;
  forwardTo: string;
  setForwardTo: (v: string) => void;
  workspaceLabel: string;
  inboxes: InboxSpec[];
  mode: DomainMode;
  /** Adding inboxes to a domain that's already set up: no DNS work at all. */
  addingToExisting: boolean;
  existingCount: number;
  /** That domain is still in provisioning, waiting on DKIM before it sends. */
  awaitingDkim: boolean;
}) {
  const seats = props.inboxes.length;
  const regLabel = props.registrar === "manual" ? "Manual (you add DNS)" : props.registrar;
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Review &amp; confirm</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">Here&rsquo;s exactly what happens when you hit Create.</p>
      <div className="mb-3.5 overflow-hidden rounded-xl border border-border">
        <SumRow k="Domain" v={props.domain} mono />
        {props.addingToExisting ? (
          <SumRow k="Already on it" v={inboxCount(props.existingCount)} />
        ) : (
          <SumRow k="DNS / registrar" v={regLabel} />
        )}
        <SumRow k="Workspace" v={props.workspaceLabel} />
        <SumRow
          k={props.addingToExisting ? "New inboxes" : "Inboxes"}
          v={`${seats} · ${props.inboxes.map((i) => `${i.first} ${i.last}`.trim() || i.local).join(", ")}`}
        />
        <SumRow k="Est. cost" v={seatCost(seats, props.mode === "buy")} />
      </div>

      {props.addingToExisting ? (
        <div className="space-y-2.5">
          <Callout kind="ok">
            <b>No DNS changes.</b> {props.domain} is already set up, so this only creates the new Google users
            on {props.workspaceLabel} and registers them as sending inboxes. Each one starts at 5 sends a day
            and ramps up from there.
          </Callout>
          {props.awaitingDkim && (
            <Callout kind="warn">
              <b>{props.domain} is still waiting on DKIM.</b> The new inboxes start sending once DKIM is
              detected; paste it on the domain&rsquo;s row if you haven&rsquo;t yet.
            </Callout>
          )}
        </div>
      ) : (
        <>
          <Label className="text-xs">DNS records for this domain</Label>
          <div className="mt-1.5 overflow-hidden rounded-xl border border-border">
            <table className="w-full font-mono text-[11.5px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2.5 py-1.5 text-left font-semibold" style={{ width: 56 }}>Type</th>
                  <th className="px-2.5 py-1.5 text-left font-semibold">Host</th>
                  <th className="px-2.5 py-1.5 text-left font-semibold">Value</th>
                </tr>
              </thead>
              <tbody className="[&_td]:border-t [&_td]:border-border/60 [&_td]:px-2.5 [&_td]:py-2 [&_td]:align-top">
                <tr><td>MX</td><td className="whitespace-nowrap">@</td><td className="[overflow-wrap:anywhere]">smtp.google.com <span className="text-muted-foreground">(priority 1)</span></td></tr>
                <tr><td>TXT</td><td className="whitespace-nowrap">@</td><td className="[overflow-wrap:anywhere]">v=spf1 include:_spf.google.com ~all</td></tr>
                <tr><td>TXT</td><td className="whitespace-nowrap">_dmarc</td><td className="[overflow-wrap:anywhere]">v=DMARC1; p=none;</td></tr>
                <tr><td>TXT</td><td className="whitespace-nowrap">@</td><td className="[overflow-wrap:anywhere]">google-site-verification=… <span className="text-muted-foreground">(added during setup)</span></td></tr>
                <tr><td>TXT</td><td className="whitespace-nowrap">google._domainkey</td><td className="text-muted-foreground [overflow-wrap:anywhere]">DKIM, generated in Google Admin, pasted at the last step</td></tr>
              </tbody>
            </table>
          </div>
          <Callout kind={props.autoDns ? "ok" : "warn"} className="mt-3">
            {props.autoDns ? (
              <>
                <b>Written to {regLabel} automatically.</b> This domain is on a connected registrar, so LeadStart
                lays down the DNS for you.
              </>
            ) : props.registrarMissingKey ? (
              <>
                <b>{regLabel} isn&rsquo;t connected.</b> This domain points at {regLabel}, but its API key isn&rsquo;t
                saved, so these records can&rsquo;t be written and setup will stall at &ldquo;Verify domain
                ownership.&rdquo; Add the key in Settings, API, then use &ldquo;Retry DNS,&rdquo; or switch the domain
                to Manual and paste them yourself.
              </>
            ) : (
              <>
                <b>You&rsquo;ll add these by hand.</b> This domain is set to Manual, so copy the records into your DNS
                host. Setup pauses until they resolve.
              </>
            )}
          </Callout>
          <p className="mt-2 text-[11px] text-muted-foreground">
            One DMARC / SPF / DKIM record covers every inbox on the domain: email auth is per-domain, not per-inbox.
          </p>

          {/* Optional URL forwarding (Porkbun only). */}
          <div className="mt-3.5 border-t border-border/60 pt-3.5">
            <Label className="text-xs">URL forwarding (optional)</Label>
            {props.forwardingSupported ? (
              <>
                <p className="mb-1.5 mt-0.5 text-[11px] text-muted-foreground">
                  301-redirect this domain to the client&rsquo;s real site so the bare domain never shows a dead
                  parked page. Leave blank to skip; you can set or change it later from the domain&rsquo;s row.
                </p>
                <Input
                  className="font-mono text-sm"
                  placeholder="https://clientsite.com"
                  value={props.forwardTo}
                  onChange={(e) => props.setForwardTo(e.target.value)}
                />
              </>
            ) : (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {props.registrar === "spaceship"
                  ? "Spaceship has no forwarding API: set the redirect manually in the Spaceship dashboard."
                  : "Available on connected Porkbun domains. You can also set it later from the domain’s row under Mailboxes."}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProvisionStep({ result, onDone }: { result: KickoffResult; onDone: () => void }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-700">
        <Check size={17} />{" "}
        {result.mode === "add_inboxes"
          ? `Adding inboxes to ${result.domain.domain}`
          : `Setup started for ${result.domain.domain}`}
      </div>
      {result.passwords.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-amber-900">
            <KeyRound size={13} /> Inbox passwords: shown once, never stored
          </div>
          <ul className="space-y-0.5 font-mono text-amber-900">
            {result.passwords.map((p) => (
              <li key={p.email}>
                {p.email}: <span className="select-all">{p.password}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-amber-700">
            Sending uses the service account, so you don&rsquo;t need these to send: reset in Google Admin if
            you ever need console login.
          </p>
        </div>
      )}
      <p className="mb-2 text-xs text-muted-foreground">
        {result.mode === "add_inboxes"
          ? "Google can take a few minutes to open each new mailbox before it registers. Watch progress here, or close and it continues in the background: the domain's row shows this same panel."
          : "Steps run in order and pick up where they left off. Watch progress here, finish DKIM, or close and it continues in the background: the domain now shows this same panel in its row."}
      </p>
      <DomainProvisioningDetail domain={result.domain} onChange={onDone} />
    </div>
  );
}

function DomainOnlyStep(props: {
  trackDomain: string;
  setTrackDomain: (v: string) => void;
  trackRegistrar: RegistrarId | "manual";
  setTrackRegistrar: (v: RegistrarId | "manual") => void;
  registrarStatus: RegistrarStatus;
}) {
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Add a domain</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Track a domain you already own. Get it in now; set up its inboxes whenever you&rsquo;re ready.
      </p>
      <div className="space-y-3">
        <div>
          <Label className="text-xs">Domain</Label>
          <Input
            className="mt-1 font-mono text-sm"
            placeholder="mail.acme.com"
            value={props.trackDomain}
            onChange={(e) => props.setTrackDomain(e.target.value)}
          />
        </div>
        <RegistrarPicker
          value={props.trackRegistrar}
          onChange={props.setTrackRegistrar}
          status={props.registrarStatus}
        />
        <Callout kind="info">
          The domain lands as <b>provisioning</b> with zero inboxes. Its row gets a <b>Set up inboxes</b>{" "}
          button: the same wizard, resumed from the Workspace step.
        </Callout>
      </div>
    </div>
  );
}

function ConnectStep(props: {
  email: string;
  setEmail: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  cap: string;
  setCap: (v: string) => void;
}) {
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Connect an existing inbox</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Registers an address you already send from, so it can join campaign rotation. It must be on a
        Workspace we&rsquo;ve authorized: we verify domain-wide delegation live before saving.
      </p>
      <div className="space-y-3">
        <div>
          <Label className="text-xs">Email address</Label>
          <Input
            className="mt-1 font-mono text-sm"
            placeholder="jane@workwithdanielt.com"
            value={props.email}
            onChange={(e) => props.setEmail(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label className="text-xs">Display name</Label>
            <Input className="mt-1" placeholder="Jane Rivera" value={props.name} onChange={(e) => props.setName(e.target.value)} />
          </div>
          <div className="w-28">
            <Label className="text-xs">Daily cap</Label>
            <Input className="mt-1" type="number" min={1} max={20} value={props.cap} onChange={(e) => props.setCap(e.target.value)} />
          </div>
        </div>
        <Callout kind="info">
          No provisioning, no DNS, no password: we just start sending through it. It ramps from 5/day like any
          new inbox unless you override the cap.
        </Callout>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared bits

function SumRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 px-3 py-2.5 text-[13px] last:border-b-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={`text-right font-medium ${mono ? "font-mono text-xs" : ""}`}>{v}</span>
    </div>
  );
}

function Callout({
  kind,
  children,
  className = "",
}: {
  kind: "info" | "ok" | "warn";
  children: ReactNode;
  className?: string;
}) {
  const styles = {
    info: "border-primary/25 bg-primary/[0.04] text-[#1e2a78]",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
  }[kind];
  const Icon = kind === "ok" ? Check : kind === "warn" ? AlertTriangle : Info;
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs ${styles} ${className}`}>
      <Icon size={15} className="mt-px flex-none" />
      <span>{children}</span>
    </div>
  );
}
