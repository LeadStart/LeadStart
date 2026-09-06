"use client";

// First-login onboarding modal (Split format). Shown once, over the client
// portal, to capture where interested leads should be sent + who to CC, and to
// teach how reply routing works. Writes to clients.notification_email +
// notification_cc_emails via the same PATCH the Settings page uses, so the same
// values stay editable there afterwards.
//
// Trigger (OnboardingGate): a logged-in client whose notification_email is not
// yet set and who hasn't dismissed it on this device. Once they save an email,
// the server value suppresses it everywhere; a skip suppresses it on this
// device (localStorage). Never shown to an admin previewing the portal.

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmailTagInput } from "@/components/ui/email-tag-input";
import { appUrl } from "@/lib/api-url";
import { useClientData } from "./client-data-context";
import {
  ArrowRight,
  Bell,
  Users,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import type { Client } from "@/types/app";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const seenKey = (clientId: string) => `ls-onboarding-seen:${clientId}`;

const eyebrowCls =
  "text-[11px] font-bold uppercase tracking-[0.08em] text-[#2E37FE]";
const titleCls =
  "mt-1.5 mb-1.5 text-[22px] font-bold leading-tight tracking-tight text-foreground";
const subCls = "text-[13.5px] leading-relaxed text-muted-foreground";

function Dots({ active }: { active: number }) {
  return (
    <div className="mb-3 flex gap-1.5">
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={`h-[7px] rounded-full transition-all ${
            n === active ? "w-5 bg-[#2E37FE]" : "w-[7px] bg-border"
          }`}
        />
      ))}
    </div>
  );
}

function FlowRow({ n, title, detail }: { n: number; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-[#a3a8ff]/40 bg-[#a3a8ff]/15 text-[13px] font-bold text-[#c3ccff]">
        {n}
      </div>
      <div>
        <p className="text-[13px] font-semibold leading-tight text-white">{title}</p>
        <p className="mt-0.5 text-xs leading-snug text-slate-400">{detail}</p>
      </div>
    </div>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-[#2E37FE]/10 text-[#2E37FE]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="truncate text-[13px] font-semibold text-foreground">{value}</p>
      </div>
    </div>
  );
}

function OnboardingModal({
  client,
  open,
  onDismiss,
}: {
  client: Client;
  open: boolean;
  onDismiss: () => void;
}) {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState(client.notification_email ?? "");
  const [ccs, setCcs] = useState<string[]>(client.notification_cc_emails ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/clients/${client.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Save failed (${res.status})`);
        return false;
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function fromEmail() {
    const e = email.trim();
    if (e && !EMAIL_SHAPE.test(e)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (e) {
      const ok = await patch({ notification_email: e });
      if (!ok) return;
    }
    setError(null);
    setStep(3);
  }

  async function fromTeammates() {
    const ok = await patch({ notification_cc_emails: ccs });
    if (!ok) return;
    setStep(4);
  }

  // --- Per-step panes ------------------------------------------------------
  let left: React.ReactNode = null;
  let right: React.ReactNode = null;

  if (step === 1) {
    left = (
      <>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#a3a8ff]">
          Welcome aboard
        </p>
        <h3 className="mt-3 mb-4 text-[19px] font-bold leading-snug text-white">
          Let&apos;s get your leads flowing.
        </h3>
        <p className="text-[13px] leading-relaxed text-slate-300">
          Your campaigns are being prepared. Two quick steps now and interested
          leads land straight in your inbox.
        </p>
        <div className="mt-auto flex gap-2 pt-4 text-[11.5px] leading-snug text-slate-400">
          <CheckCircle2 className="mt-0.5 size-[15px] flex-none text-[#c3ccff]" />
          <span>
            You can skip this and finish anytime from Settings. Nothing breaks if
            you do it later.
          </span>
        </div>
      </>
    );
    right = (
      <>
        <Dots active={1} />
        <p className={eyebrowCls}>Welcome to LeadStart</p>
        <h2 className={titleCls}>You&apos;re in. Let&apos;s route your leads.</h2>
        <p className={subCls}>
          Set where interested prospects should reach you. It takes about 30
          seconds.
        </p>
        <div className="mt-auto flex items-center gap-2.5 pt-6">
          <Button
            onClick={() => setStep(2)}
            className="flex-1 gap-1.5"
            style={{ background: "#2E37FE" }}
          >
            Set up lead routing <ArrowRight size={16} />
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            Skip for now
          </Button>
        </div>
      </>
    );
  } else if (step === 2) {
    left = (
      <>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#a3a8ff]">
          How leads reach you
        </p>
        <h3 className="mt-3 mb-4 text-[19px] font-bold leading-snug text-white">
          Here&apos;s how interested leads reach you.
        </h3>
        <div className="flex flex-col">
          <FlowRow
            n={1}
            title="A prospect replies"
            detail="They answer the campaign in your warmed inbox."
          />
          <div className="ml-[13px] h-4 w-px bg-[#a3a8ff]/30" />
          <FlowRow
            n={2}
            title="You reply in the portal"
            detail="Answer right here. It sends under your name and signature."
          />
          <div className="ml-[13px] h-4 w-px bg-[#a3a8ff]/30" />
          <FlowRow
            n={3}
            title="We CC your inbox"
            detail="The whole thread also lands in your email."
          />
        </div>
        <div className="mt-auto flex gap-2 pt-4 text-[11.5px] leading-snug text-slate-400">
          <AlertTriangle className="mt-0.5 size-[15px] flex-none text-amber-400" />
          <span>
            Replying from your own inbox can hit spam and break the thread.
            Staying on the warmed inbox keeps it flowing.
          </span>
        </div>
      </>
    );
    right = (
      <>
        <Dots active={2} />
        <p className={eyebrowCls}>Step 1 of 2</p>
        <h2 className={titleCls}>Where should your leads land?</h2>
        <p className={subCls}>
          Pick the email you check most. We&apos;ll notify you the moment
          someone&apos;s interested.
        </p>
        <div className="mt-5 space-y-1.5">
          <Label htmlFor="onb-email">Notification email</Label>
          <Input
            id="onb-email"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            disabled={saving}
          />
          <p className="text-[11px] text-muted-foreground">
            Used for hot-lead alerts, and CC&apos;d on every reply thread.
          </p>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-auto flex items-center gap-2 pt-6">
          <Button variant="ghost" onClick={() => setStep(1)} disabled={saving}>
            Back
          </Button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onDismiss}
            className="text-[13px] font-semibold text-muted-foreground hover:text-foreground"
          >
            I&apos;ll do this later
          </button>
          <Button
            onClick={fromEmail}
            disabled={saving}
            className="gap-1.5"
            style={{ background: "#2E37FE" }}
          >
            {saving ? "Saving…" : "Continue"} <ArrowRight size={16} />
          </Button>
        </div>
      </>
    );
  } else if (step === 3) {
    left = (
      <>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#a3a8ff]">
          Bring your team
        </p>
        <h3 className="mt-3 mb-4 text-[19px] font-bold leading-snug text-white">
          Never let a hot lead wait on one person.
        </h3>
        <p className="text-[13px] leading-relaxed text-slate-300">
          Everyone you add gets the same instant alert and rides on every reply
          thread, so a teammate can jump in even when you&apos;re out.
        </p>
        <div className="mt-4 flex">
          <span className="flex size-9 items-center justify-center rounded-full border-2 border-[#1b2273] bg-[#2E37FE] text-xs font-bold text-white">
            Y
          </span>
          <span className="-ml-2 flex size-9 items-center justify-center rounded-full border-2 border-[#1b2273] bg-[#6B72FF] text-xs font-bold text-white">
            J
          </span>
          <span className="-ml-2 flex size-9 items-center justify-center rounded-full border-2 border-[#1b2273] bg-[#A3A8FF] text-xs font-bold text-white">
            M
          </span>
          <span className="-ml-2 flex size-9 items-center justify-center rounded-full border-2 border-[#1b2273] bg-[#a3a8ff]/25 text-xs font-bold text-[#c3ccff]">
            +
          </span>
        </div>
        <div className="mt-auto flex gap-2 pt-4 text-[11.5px] leading-snug text-slate-400">
          <CheckCircle2 className="mt-0.5 size-[15px] flex-none text-[#c3ccff]" />
          <span>Optional. Add or remove teammates anytime in Settings.</span>
        </div>
      </>
    );
    right = (
      <>
        <Dots active={3} />
        <p className={eyebrowCls}>Step 2 of 2 · optional</p>
        <h2 className={titleCls}>Who else should get leads?</h2>
        <p className={subCls}>Add teammates to CC on alerts and reply threads.</p>
        <div className="mt-5 space-y-1.5">
          <Label>CC teammates</Label>
          <EmailTagInput
            value={ccs}
            onChange={setCcs}
            placeholder="teammate@company.com, then Enter"
            max={10}
            disabled={saving}
          />
          <p className="text-[11px] text-muted-foreground">
            Add as many as you like. Remove anytime.
          </p>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-auto flex items-center gap-2 pt-6">
          <Button variant="ghost" onClick={() => setStep(2)} disabled={saving}>
            Back
          </Button>
          <span className="flex-1" />
          <Button
            onClick={fromTeammates}
            disabled={saving}
            className="gap-1.5"
            style={{ background: "#2E37FE" }}
          >
            {saving ? "Saving…" : "Continue"} <ArrowRight size={16} />
          </Button>
        </div>
      </>
    );
  } else {
    right = (
      <>
        <Dots active={4} />
        <p className={eyebrowCls}>All done</p>
        <h2 className={titleCls}>Your leads are routed.</h2>
        <p className={subCls}>
          Here&apos;s where everything will go. Change any of it anytime in
          Settings.
        </p>
        <div className="mt-5 flex flex-col gap-2.5">
          <SummaryRow
            icon={<Bell size={16} />}
            label="Alerts sent to"
            value={email.trim() || "Set later in Settings"}
          />
          {ccs.length > 0 && (
            <SummaryRow
              icon={<Users size={16} />}
              label="Also CC'd"
              value={ccs.join(", ")}
            />
          )}
        </div>
        <div className="mt-auto flex items-center gap-2 pt-6">
          <Button variant="ghost" onClick={() => setStep(3)}>
            Back
          </Button>
          <span className="flex-1" />
          <Button
            onClick={onDismiss}
            className="gap-1.5"
            style={{ background: "#2E37FE" }}
          >
            Go to my dashboard <ArrowRight size={16} />
          </Button>
        </div>
      </>
    );
    left = (
      <>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#a3a8ff]">
          All set
        </p>
        <h3 className="mt-3 mb-4 text-[19px] font-bold leading-snug text-white">
          You&apos;re ready to go!
        </h3>
        <p className="text-[13px] leading-relaxed text-slate-300">
          We&apos;re setting up your campaigns for you now. Nothing else from you
          at this time!
        </p>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onDismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(780px,94vw)] gap-0 overflow-hidden p-0 sm:max-w-[780px]"
      >
        <DialogTitle className="sr-only">Set up where your leads go</DialogTitle>
        <div className="grid min-h-[476px] sm:grid-cols-[300px_1fr]">
          <aside className="hidden flex-col bg-[linear-gradient(180deg,#1b2273,#0f172a)] p-7 text-slate-200 sm:flex">
            {left}
          </aside>
          <div className="flex flex-col p-6 sm:p-7">{right}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Decides whether to show the onboarding modal, and remembers dismissal.
// Mounted once inside the client portal layout.
export function OnboardingGate() {
  const { client, loading, previewing } = useClientData();
  const [dismissed, setDismissed] = useState(false);

  // localStorage is client-only. The portal resolves `client` after hydration
  // (the context fetches in the browser), so this reads only on the client —
  // the server pass renders null while `client` is still null.
  const seen = useMemo(() => {
    if (!client) return false;
    try {
      return localStorage.getItem(seenKey(client.id)) === "1";
    } catch {
      return false;
    }
  }, [client]);

  if (!client) return null;

  // Shown once to a client whose notification_email isn't set yet and who
  // hasn't dismissed it here. Saving an email suppresses it everywhere (server
  // value); a skip suppresses it on this device. Never during an admin preview.
  const show =
    !loading &&
    !previewing &&
    !client.notification_email &&
    !seen &&
    !dismissed;

  function dismiss() {
    try {
      localStorage.setItem(seenKey(client!.id), "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  return <OnboardingModal client={client} open={show} onDismiss={dismiss} />;
}
