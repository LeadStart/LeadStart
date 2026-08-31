"use client";

// The single "Add" entry point for the Mailboxes tab. One blue button opens a
// chooser with three doors, then walks the guided flow for each:
//   • Sending inboxes — domain (bring-your-own / use-existing / buy) → Workspace
//     → name inboxes (first/last + handle) → review DNS → provision (kicks off
//     the state machine, reveals one-time passwords, embeds the live stepper +
//     DKIM paste from DomainProvisioningDetail).
//   • A domain only — track one you own or buy a fresh one (inboxes later).
//   • Connect an existing inbox — register an address on a Workspace we manage.
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
import type { SendingDomain } from "@/types/app";
import { DomainProvisioningDetail } from "./domain-provisioning-detail";

type DomainRow = SendingDomain & { mailbox_count: number };
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
}

const STEP_TITLES = ["Domain", "Workspace", "Inboxes", "Review", "Provision"];
const REGISTRARS: { id: RegistrarId; label: string }[] = [
  { id: "porkbun", label: "Porkbun" },
  { id: "spaceship", label: "Spaceship" },
];
const RECOMMENDED_MAX = 3;
const HARD_MAX = 10;

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function usd(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

export function AddMailboxWizard({
  open,
  onOpenChange,
  domains,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  domains: DomainRow[];
  onDone: () => void;
}) {
  const [door, setDoor] = useState<Door>("chooser");
  const [step, setStep] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which registrars actually have API keys saved — so the picker can show
  // connection state instead of silently offering an unconfigured registrar.
  const [registrarStatus, setRegistrarStatus] = useState<{
    has_porkbun: boolean;
    has_spaceship: boolean;
  } | null>(null);
  // Scrollable body ref: when an action sets an error we scroll it into view
  // (the error banner renders at the top, which is off-screen on long steps).
  const bodyRef = useRef<HTMLDivElement>(null);

  // Step 1 — domain
  const [domainMode, setDomainMode] = useState<DomainMode>("track");
  const [trackDomain, setTrackDomain] = useState("");
  const [trackRegistrar, setTrackRegistrar] = useState<RegistrarId | "manual">("manual");
  const [existingId, setExistingId] = useState<string | null>(null);
  const [buyDomain, setBuyDomain] = useState("");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [buyRegistrar, setBuyRegistrar] = useState<RegistrarId | null>(null);

  // Step 2 — workspace
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsAdding, setWsAdding] = useState(false);
  const [wsLabel, setWsLabel] = useState("");
  const [wsEmail, setWsEmail] = useState("");

  // Step 3 — inboxes
  const [inboxes, setInboxes] = useState<InboxSpec[]>([
    { first: "", last: "", local: "", touched: false },
  ]);

  // Step 5 — result
  const [result, setResult] = useState<KickoffResult | null>(null);

  // Connect-existing door
  const [cxEmail, setCxEmail] = useState("");
  const [cxName, setCxName] = useState("");
  const [cxCap, setCxCap] = useState("20");

  // Domain-only door
  const [doDone, setDoDone] = useState(false);

  // Domains eligible to have inboxes set up: tracked/bought but not yet started.
  const eligibleDomains = domains.filter(
    (d) => d.tier === "gmail" && d.lifecycle_status === "provisioning" && !d.provisioning,
  );

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/workspaces"));
      if (!res.ok) return;
      const data = await res.json();
      const list: Workspace[] = data.workspaces ?? [];
      setWorkspaces(list);
      setWsId((cur) => cur ?? list.find((w) => w.is_default)?.id ?? list[0]?.id ?? null);
    } catch {
      /* best-effort — the Workspace step surfaces the empty state */
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
      /* best-effort — the picker just won't show connection state */
    }
  }, []);

  // Reset everything each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setDoor("chooser");
    setStep(1);
    setErr(null);
    setBusy(false);
    setDomainMode("track");
    setTrackDomain("");
    setTrackRegistrar("manual");
    setExistingId(null);
    setBuyDomain("");
    setQuote(null);
    setBuyRegistrar(null);
    setInboxes([{ first: "", last: "", local: "", touched: false }]);
    setResult(null);
    setCxEmail("");
    setCxName("");
    setCxCap("20");
    setDoDone(false);
    setRegistrarStatus(null);
    void loadWorkspaces();
    void loadRegistrarStatus();
  }, [open, loadWorkspaces, loadRegistrarStatus]);

  // Bring a freshly-set error into view (it renders at the top of the scroll).
  useEffect(() => {
    if (err) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [err]);

  if (!open) return null;

  // ── derived: the domain name + registrar the flow is targeting ──
  const existingDomain = eligibleDomains.find((d) => d.id === existingId) ?? null;
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
  const namedInboxes = inboxes.filter((i) => slug(i.local));

  // ── step 1 gating ──
  const step1Ready =
    domainMode === "existing"
      ? !!existingId
      : domainMode === "track"
        ? /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(trackDomain.trim().toLowerCase())
        : !!buyRegistrar && !!buyDomain.trim();

  function close() {
    onOpenChange(false);
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
    setInboxes((prev) =>
      prev.length >= HARD_MAX ? prev : [...prev, { first: "", last: "", local: "", touched: false }],
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
            workspace_id: wsId,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error ?? "Could not track that domain.");
          return;
        }
        domainRow = data.domain as SendingDomain;
      } else {
        // buy — spends real money; gated behind registrar keys + spend cap.
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
        body: JSON.stringify({ users, workspace_id: wsId }),
      });
      const data2 = await res2.json();
      if (!res2.ok) {
        setErr(data2.error ?? "Setup could not start.");
        return;
      }
      setResult({
        domain: { ...domainRow, provisioning: data2.provisioning, workspace_id: wsId ?? domainRow.workspace_id },
        passwords: Array.isArray(data2.revealed_passwords) ? data2.revealed_passwords : [],
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
  const headerTitle =
    door === "chooser"
      ? "Add to Mailboxes"
      : door === "inbox"
        ? "Set up inboxes"
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
              eligibleDomains={eligibleDomains}
              existingId={existingId}
              setExistingId={setExistingId}
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
              wsId={wsId}
              setWsId={setWsId}
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
              workspaceLabel={workspaces.find((w) => w.id === wsId)?.label ?? "default Workspace"}
              inboxes={namedInboxes}
              mode={domainMode}
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
              <Button onClick={() => { setErr(null); setStep(step + 1); }} disabled={step === 1 && !step1Ready}>
                Next
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
      desc: "Buy or use a domain and spin up Google inboxes, ready to warm up. Walks the full setup.",
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
        Inboxes live inside a domain, and a domain lives on a Google Workspace — so most of the time you
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
            {pkOn ? "Porkbun — auto-writes DNS" : "Porkbun — not connected (add key in Settings)"}
          </option>
          <option value="spaceship">
            {ssOn ? "Spaceship — auto-writes DNS" : "Spaceship — not connected (add key in Settings)"}
          </option>
          <option value="manual">Manual — you&rsquo;ll add the records by hand</option>
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
  eligibleDomains: DomainRow[];
  existingId: string | null;
  setExistingId: (v: string) => void;
  buyDomain: string;
  setBuyDomain: (v: string) => void;
  quote: QuoteResult | null;
  quoting: boolean;
  runQuote: () => void;
  buyRegistrar: RegistrarId | null;
  setBuyRegistrar: (v: RegistrarId) => void;
}) {
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
          <RegistrarPicker
            value={props.trackRegistrar}
            onChange={props.setTrackRegistrar}
            status={props.registrarStatus}
          />
        </div>
      )}

      {props.mode === "existing" && (
        <div className="space-y-2">
          <Label className="text-xs">Pick a domain that&rsquo;s ready for inboxes</Label>
          {props.eligibleDomains.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              No domains waiting for inbox setup. Bring your own or buy a new one, or a domain you already
              provisioned is done.
            </p>
          ) : (
            props.eligibleDomains.map((d) => (
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
                    {d.registrar === "manual" ? "Manual DNS" : d.registrar} · awaiting inbox setup
                  </span>
                </span>
              </button>
            ))
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
                    <div className="mt-1 text-lg font-bold tabular-nums">{selectable ? usd(q?.price_usd) : "—"}</div>
                    <div className="text-[11px] text-muted-foreground">{selectable ? "available · first year" : "unavailable"}</div>
                  </button>
                );
              })}
            </div>
          )}
          <Callout kind="warn">
            <b>Spends real money.</b> The purchase is gated behind registrar keys + a monthly spend cap.
            Plus ~$7–8/mo per Google seat once inboxes are created.
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
  adding: boolean;
  setAdding: (v: boolean) => void;
  label: string;
  setLabel: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  addWorkspace: () => void;
  busy: boolean;
}) {
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Which Google Workspace should host it?</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Every inbox sends through one service account that impersonates the address — so what matters is
        that the Workspace has authorized that service account.
      </p>
      <div className="space-y-2">
        {props.workspaces.map((w) => (
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
        {props.workspaces.length === 0 && (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            No Workspaces yet. Add one below — its admin still needs to authorize the service account&rsquo;s
            client ID in Google Admin before provisioning can run.
          </p>
        )}
      </div>

      {props.adding ? (
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
  editInbox: (i: number, key: "first" | "last" | "local", v: string) => void;
  addInbox: () => void;
  removeInbox: (i: number) => void;
}) {
  const n = props.inboxes.length;
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Name the inboxes</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">
        Google creates each user with a real first &amp; last name — that&rsquo;s the From name recipients
        see. The mailbox handle is auto-suggested from the first name; edit it freely. Avoid role addresses
        like <span className="font-mono">info@</span>.
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
      {n < HARD_MAX && (
        <button className="text-xs font-semibold text-primary hover:underline" onClick={props.addInbox}>
          + Add inbox
        </button>
      )}
      {n > RECOMMENDED_MAX ? (
        <Callout kind="warn" className="mt-2.5">
          <b>{n} inboxes on one domain.</b> {RECOMMENDED_MAX} is the recommended max for deliverability —
          you can add more, but warm them slowly and watch placement.
        </Callout>
      ) : (
        <p className="mt-2.5 text-xs text-muted-foreground">
          Tip: {RECOMMENDED_MAX} inboxes per domain is the deliverability sweet spot — add more only if you need to.
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
  workspaceLabel: string;
  inboxes: InboxSpec[];
  mode: DomainMode;
}) {
  const seats = props.inboxes.length;
  const regLabel = props.registrar === "manual" ? "Manual (you add DNS)" : props.registrar;
  return (
    <div>
      <h3 className="text-[15px] font-semibold">Review &amp; confirm</h3>
      <p className="mb-3.5 mt-1 text-xs text-muted-foreground">Here&rsquo;s exactly what happens when you hit Create.</p>
      <div className="mb-3.5 overflow-hidden rounded-xl border border-border">
        <SumRow k="Domain" v={props.domain} mono />
        <SumRow k="DNS / registrar" v={regLabel} />
        <SumRow k="Workspace" v={props.workspaceLabel} />
        <SumRow k="Inboxes" v={`${seats} · ${props.inboxes.map((i) => `${i.first} ${i.last}`.trim() || i.local).join(", ")}`} />
        <SumRow
          k="Est. cost"
          v={`~$${(seats * 7.5).toFixed(0)}–${(seats * 8.4).toFixed(0)}/mo (Google seats)${props.mode === "buy" ? " + domain" : ""}`}
        />
      </div>

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
            <tr><td>TXT</td><td className="whitespace-nowrap">google._domainkey</td><td className="text-muted-foreground [overflow-wrap:anywhere]">DKIM — generated in Google Admin, pasted at the last step</td></tr>
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
        One DMARC / SPF / DKIM record covers every inbox on the domain — email auth is per-domain, not per-inbox.
      </p>
    </div>
  );
}

function ProvisionStep({ result, onDone }: { result: KickoffResult; onDone: () => void }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-700">
        <Check size={17} /> Setup started for {result.domain.domain}
      </div>
      {result.passwords.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-amber-900">
            <KeyRound size={13} /> Inbox passwords — shown once, never stored
          </div>
          <ul className="space-y-0.5 font-mono text-amber-900">
            {result.passwords.map((p) => (
              <li key={p.email}>
                {p.email}: <span className="select-all">{p.password}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-amber-700">
            Sending uses the service account, so you don&rsquo;t need these to send — reset in Google Admin if
            you ever need console login.
          </p>
        </div>
      )}
      <p className="mb-2 text-xs text-muted-foreground">
        Steps run in order and pick up where they left off. Watch progress here, finish DKIM, or close and it
        continues in the background — the domain now shows this same panel in its row.
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
          button — the same wizard, resumed from the Workspace step.
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
        Workspace we&rsquo;ve authorized — we verify domain-wide delegation live before saving.
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
          No provisioning, no DNS, no password — we just start sending through it. It ramps from 5/day like any
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
