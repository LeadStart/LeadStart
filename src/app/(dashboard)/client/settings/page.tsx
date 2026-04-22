"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { appUrl } from "@/lib/api-url";
import { useClientData } from "../client-data-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  User,
  Mail,
  KeyRound,
  Bell,
  Phone,
  Users,
  FileText,
  PenLine,
  Save,
  CheckCircle2,
  X,
  AlertCircle,
} from "lucide-react";
import type { Client } from "@/types/app";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same cadence options admin uses — keep the two surfaces in sync.
const CADENCE_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 7, label: "Weekly" },
  { value: 14, label: "Bi-weekly" },
  { value: 30, label: "Monthly" },
];

type SaveState = "idle" | "saving" | "saved" | "error";

interface SectionStatus {
  state: SaveState;
  message?: string;
}

function SaveStatus({ status }: { status: SectionStatus }) {
  if (status.state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
        <CheckCircle2 size={12} /> Saved
      </span>
    );
  }
  if (status.state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-600">
        <AlertCircle size={12} /> {status.message || "Failed to save"}
      </span>
    );
  }
  return null;
}

// Small tag-style multi-email input. Accepts comma, semicolon, Enter, or
// blur to commit the current buffer. Renders committed addresses as pills
// with an X button.
function EmailTagInput({
  value,
  onChange,
  placeholder,
  max,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max: number;
  disabled?: boolean;
}) {
  const [buffer, setBuffer] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit(raw: string) {
    const trimmed = raw.trim().toLowerCase().replace(/[,;]\s*$/, "");
    if (!trimmed) {
      setBuffer("");
      return;
    }
    if (!EMAIL_SHAPE.test(trimmed)) {
      setError(`"${raw.trim()}" isn't a valid email.`);
      return;
    }
    if (value.includes(trimmed)) {
      setError("Already added.");
      return;
    }
    if (value.length >= max) {
      setError(`Max ${max} addresses.`);
      return;
    }
    onChange([...value, trimmed]);
    setBuffer("");
    setError(null);
  }

  function remove(email: string) {
    onChange(value.filter((e) => e !== email));
  }

  return (
    <div className="space-y-1.5">
      <div
        className={`flex flex-wrap gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-2 min-h-[42px] ${
          disabled ? "opacity-60" : ""
        }`}
      >
        {value.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-full bg-[#2E37FE]/10 px-2.5 py-0.5 text-xs text-[#2E37FE]"
          >
            {email}
            <button
              type="button"
              onClick={() => !disabled && remove(email)}
              disabled={disabled}
              className="rounded-full hover:bg-[#2E37FE]/20 p-0.5 cursor-pointer disabled:cursor-not-allowed"
              aria-label={`Remove ${email}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          type="email"
          value={buffer}
          onChange={(e) => {
            setBuffer(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === ";") {
              e.preventDefault();
              commit(buffer);
            } else if (e.key === "Backspace" && buffer === "" && value.length > 0) {
              remove(value[value.length - 1]);
            }
          }}
          onBlur={() => buffer && commit(buffer)}
          placeholder={value.length === 0 ? placeholder : ""}
          disabled={disabled}
          className="flex-1 min-w-[140px] bg-transparent text-sm outline-none disabled:cursor-not-allowed"
        />
      </div>
      {error && (
        <p className="text-[11px] text-red-600">{error}</p>
      )}
    </div>
  );
}

export default function ClientSettingsPage() {
  const { client: contextClient, userId, loading: contextLoading, noClient } = useClientData();

  // Local copy of the client row so saves can update instantly without
  // round-tripping the shared context. We re-fetch on mount to get any
  // fields the context may not carry (e.g., notification_cc_emails on old
  // cached contexts).
  const [client, setClient] = useState<Client | null>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(true);

  // --- Local form state per section ---
  const [accountForm, setAccountForm] = useState({ full_name: "", email: "" });
  const [passwordForm, setPasswordForm] = useState({ next: "", confirm: "" });

  const [notifyForm, setNotifyForm] = useState({
    notification_email: "",
    phone_number: "",
    notification_cc_emails: [] as string[],
  });

  const [reportsForm, setReportsForm] = useState({
    report_interval_days: 0,
    report_recipients: [] as string[],
  });

  const [signatureForm, setSignatureForm] = useState({ signature_block: "" });

  // --- Save state per section ---
  const [accountStatus, setAccountStatus] = useState<SectionStatus>({ state: "idle" });
  const [passwordStatus, setPasswordStatus] = useState<SectionStatus>({ state: "idle" });
  const [notifyStatus, setNotifyStatus] = useState<SectionStatus>({ state: "idle" });
  const [reportsStatus, setReportsStatus] = useState<SectionStatus>({ state: "idle" });
  const [signatureStatus, setSignatureStatus] = useState<SectionStatus>({ state: "idle" });

  useEffect(() => {
    if (contextLoading) return;
    if (!contextClient || !userId) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    Promise.all([
      supabase.auth.getUser(),
      supabase.from("clients").select("*").eq("id", contextClient.id).single(),
      supabase.from("profiles").select("full_name, email").eq("id", userId).single(),
    ]).then(([authRes, clientRes, profileRes]) => {
      if (authRes.data.user?.email) setEmail(authRes.data.user.email);
      const c = (clientRes.data as Client | null);
      if (c) {
        setClient(c);
        setNotifyForm({
          notification_email: c.notification_email ?? "",
          phone_number: c.phone_number ?? "",
          notification_cc_emails: c.notification_cc_emails ?? [],
        });
        setReportsForm({
          report_interval_days: c.report_interval_days ?? 0,
          report_recipients: c.report_recipients ?? [],
        });
        setSignatureForm({ signature_block: c.signature_block ?? "" });
      }
      const p = profileRes.data as { full_name: string | null; email: string } | null;
      const name = p?.full_name ?? "";
      setFullName(name);
      setAccountForm({ full_name: name, email: authRes.data.user?.email ?? p?.email ?? "" });
      setLoading(false);
    });
  }, [contextClient, contextLoading, userId]);

  const clientId = client?.id;

  // --- Save handlers ---
  async function patchClient(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    if (!clientId) return { ok: false, error: "Client not loaded yet." };
    try {
      const res = await fetch(appUrl(`/api/clients/${clientId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error || `Save failed (${res.status})` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }

  async function handleSaveAccount() {
    setAccountStatus({ state: "saving" });
    const supabase = createClient();
    const trimmedName = accountForm.full_name.trim();
    const trimmedEmail = accountForm.email.trim().toLowerCase();

    // Name → profiles table (user owns their own profile row via RLS).
    if (trimmedName !== fullName.trim() && userId) {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: trimmedName || null })
        .eq("id", userId);
      if (error) {
        setAccountStatus({ state: "error", message: `Name: ${error.message}` });
        return;
      }
      setFullName(trimmedName);
    }

    // Email → Supabase auth. Sends a confirmation email; the change isn't
    // applied until the user clicks the link.
    if (trimmedEmail && trimmedEmail !== email.toLowerCase()) {
      if (!EMAIL_SHAPE.test(trimmedEmail)) {
        setAccountStatus({ state: "error", message: "Enter a valid email." });
        return;
      }
      const { error } = await supabase.auth.updateUser({ email: trimmedEmail });
      if (error) {
        setAccountStatus({ state: "error", message: `Email: ${error.message}` });
        return;
      }
      setAccountStatus({
        state: "saved",
        message: "Confirmation email sent — check your inbox to apply the change.",
      });
      setTimeout(() => setAccountStatus({ state: "idle" }), 6000);
      return;
    }

    setAccountStatus({ state: "saved" });
    setTimeout(() => setAccountStatus({ state: "idle" }), 2500);
  }

  async function handleSavePassword() {
    setPasswordStatus({ state: "saving" });
    if (passwordForm.next.length < 8) {
      setPasswordStatus({ state: "error", message: "Password must be at least 8 characters." });
      return;
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setPasswordStatus({ state: "error", message: "Passwords don't match." });
      return;
    }
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: passwordForm.next });
    if (error) {
      setPasswordStatus({ state: "error", message: error.message });
      return;
    }
    setPasswordForm({ next: "", confirm: "" });
    setPasswordStatus({ state: "saved" });
    setTimeout(() => setPasswordStatus({ state: "idle" }), 2500);
  }

  async function handleSaveNotifications() {
    setNotifyStatus({ state: "saving" });
    const trimmedPrimary = notifyForm.notification_email.trim().toLowerCase();
    if (trimmedPrimary && !EMAIL_SHAPE.test(trimmedPrimary)) {
      setNotifyStatus({ state: "error", message: "Primary notification email is invalid." });
      return;
    }
    const result = await patchClient({
      notification_email: trimmedPrimary || null,
      phone_number: notifyForm.phone_number.trim() || null,
      notification_cc_emails: notifyForm.notification_cc_emails,
    });
    if (!result.ok) {
      setNotifyStatus({ state: "error", message: result.error });
      return;
    }
    // Locally reflect the normalized values the server returns
    setNotifyForm((prev) => ({ ...prev, notification_email: trimmedPrimary }));
    setNotifyStatus({ state: "saved" });
    setTimeout(() => setNotifyStatus({ state: "idle" }), 2500);
  }

  async function handleSaveReports() {
    setReportsStatus({ state: "saving" });
    const interval = reportsForm.report_interval_days;
    const result = await patchClient({
      report_interval_days: interval > 0 ? interval : null,
      report_recipients: reportsForm.report_recipients,
    });
    if (!result.ok) {
      setReportsStatus({ state: "error", message: result.error });
      return;
    }
    setReportsStatus({ state: "saved" });
    setTimeout(() => setReportsStatus({ state: "idle" }), 2500);
  }

  async function handleSaveSignature() {
    setSignatureStatus({ state: "saving" });
    const result = await patchClient({
      signature_block: signatureForm.signature_block.trim() || null,
    });
    if (!result.ok) {
      setSignatureStatus({ state: "error", message: result.error });
      return;
    }
    setSignatureStatus({ state: "saved" });
    setTimeout(() => setSignatureStatus({ state: "idle" }), 2500);
  }

  const cadenceLabel = useMemo(() => {
    const opt = CADENCE_OPTIONS.find((o) => o.value === reportsForm.report_interval_days);
    return opt?.label ?? "Custom";
  }, [reportsForm.report_interval_days]);

  if (contextLoading || loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-48 rounded bg-muted/50" />
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-40 rounded-xl bg-muted/50" />
        ))}
      </div>
    );
  }

  if (noClient || !client) {
    return (
      <div className="flex items-center justify-center h-64 text-center">
        <div>
          <p className="text-muted-foreground font-medium">Your account is being set up.</p>
          <p className="text-sm text-muted-foreground">Settings will be available once setup completes.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-bold text-[#0f172a]" style={{ letterSpacing: "-0.01em" }}>
          Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account, notifications, and report preferences.
        </p>
      </div>

      {/* ===== Account ===== */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <User size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="full_name">Your name</Label>
              <Input
                id="full_name"
                placeholder="Jane Doe"
                value={accountForm.full_name}
                onChange={(e) => setAccountForm((p) => ({ ...p, full_name: e.target.value }))}
                disabled={accountStatus.state === "saving"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login_email">Login email</Label>
              <Input
                id="login_email"
                type="email"
                value={accountForm.email}
                onChange={(e) => setAccountForm((p) => ({ ...p, email: e.target.value }))}
                disabled={accountStatus.state === "saving"}
              />
              <p className="text-[11px] text-muted-foreground">
                Changes require confirmation from the new address.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-1 border-t border-border/30 pt-3">
            <Button
              onClick={handleSaveAccount}
              disabled={accountStatus.state === "saving"}
              className="gap-1.5"
              style={{ background: "#2E37FE" }}
            >
              <Save size={14} />
              {accountStatus.state === "saving" ? "Saving…" : "Save"}
            </Button>
            <SaveStatus status={accountStatus} />
          </div>
        </CardContent>
      </Card>

      {/* ===== Password ===== */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <KeyRound size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new_password">New password</Label>
              <Input
                id="new_password"
                type="password"
                placeholder="At least 8 characters"
                value={passwordForm.next}
                onChange={(e) => setPasswordForm((p) => ({ ...p, next: e.target.value }))}
                disabled={passwordStatus.state === "saving"}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm_password">Confirm</Label>
              <Input
                id="confirm_password"
                type="password"
                placeholder="Retype new password"
                value={passwordForm.confirm}
                onChange={(e) => setPasswordForm((p) => ({ ...p, confirm: e.target.value }))}
                disabled={passwordStatus.state === "saving"}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 pt-3 border-t border-border/30">
            <Button
              onClick={handleSavePassword}
              disabled={
                passwordStatus.state === "saving" ||
                !passwordForm.next ||
                !passwordForm.confirm
              }
              className="gap-1.5"
              style={{ background: "#2E37FE" }}
            >
              <Save size={14} />
              {passwordStatus.state === "saving" ? "Saving…" : "Change password"}
            </Button>
            <SaveStatus status={passwordStatus} />
          </div>
        </CardContent>
      </Card>

      {/* ===== Notifications ===== */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Bell size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Hot-lead notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="notification_email" className="inline-flex items-center gap-1.5">
                <Mail size={12} className="text-muted-foreground" /> Primary email
              </Label>
              <Input
                id="notification_email"
                type="email"
                placeholder="you@company.com"
                value={notifyForm.notification_email}
                onChange={(e) =>
                  setNotifyForm((p) => ({ ...p, notification_email: e.target.value }))
                }
                disabled={notifyStatus.state === "saving"}
              />
              <p className="text-[11px] text-muted-foreground">
                Where hot-lead dossier emails are delivered.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone_number" className="inline-flex items-center gap-1.5">
                <Phone size={12} className="text-muted-foreground" /> Phone number
              </Label>
              <Input
                id="phone_number"
                type="tel"
                placeholder="+1 555 123 4567"
                value={notifyForm.phone_number}
                onChange={(e) =>
                  setNotifyForm((p) => ({ ...p, phone_number: e.target.value }))
                }
                disabled={notifyStatus.state === "saving"}
              />
              <p className="text-[11px] text-muted-foreground">
                Shown in the dossier so you can dial quickly.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="inline-flex items-center gap-1.5">
              <Users size={12} className="text-muted-foreground" /> CC teammates
            </Label>
            <EmailTagInput
              value={notifyForm.notification_cc_emails}
              onChange={(next) =>
                setNotifyForm((p) => ({ ...p, notification_cc_emails: next }))
              }
              placeholder="teammate@company.com, then Enter"
              max={10}
              disabled={notifyStatus.state === "saving"}
            />
            <p className="text-[11px] text-muted-foreground">
              CC&apos;d on every hot-lead notification and on replies you send from the portal. Up to 10 addresses.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-3 border-t border-border/30">
            <Button
              onClick={handleSaveNotifications}
              disabled={notifyStatus.state === "saving"}
              className="gap-1.5"
              style={{ background: "#2E37FE" }}
            >
              <Save size={14} />
              {notifyStatus.state === "saving" ? "Saving…" : "Save"}
            </Button>
            <SaveStatus status={notifyStatus} />
          </div>
        </CardContent>
      </Card>

      {/* ===== Reports ===== */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <FileText size={16} className="text-white" />
          </div>
          <CardTitle className="text-base flex-1">Reports</CardTitle>
          <Badge variant="secondary" className="badge-slate text-[10px]">
            {cadenceLabel}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Delivery cadence</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {CADENCE_OPTIONS.map((opt) => {
                const selected = reportsForm.report_interval_days === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      setReportsForm((p) => ({ ...p, report_interval_days: opt.value }))
                    }
                    disabled={reportsStatus.state === "saving"}
                    className={`text-sm px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                      selected
                        ? "border-[#2E37FE] bg-[#2E37FE]/10 text-[#2E37FE] font-medium"
                        : "border-border/60 hover:bg-muted/50"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              How often we email your KPI report. &ldquo;Off&rdquo; pauses all scheduled sends.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Recipients</Label>
            <EmailTagInput
              value={reportsForm.report_recipients}
              onChange={(next) => setReportsForm((p) => ({ ...p, report_recipients: next }))}
              placeholder="Leave empty to use your primary notification email"
              max={10}
              disabled={reportsStatus.state === "saving"}
            />
            <p className="text-[11px] text-muted-foreground">
              Who receives the scheduled report. Up to 10 addresses.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-3 border-t border-border/30">
            <Button
              onClick={handleSaveReports}
              disabled={reportsStatus.state === "saving"}
              className="gap-1.5"
              style={{ background: "#2E37FE" }}
            >
              <Save size={14} />
              {reportsStatus.state === "saving" ? "Saving…" : "Save"}
            </Button>
            <SaveStatus status={reportsStatus} />
          </div>
        </CardContent>
      </Card>

      {/* ===== Signature ===== */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <PenLine size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Email signature</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="signature_block">Signature block</Label>
            <Textarea
              id="signature_block"
              rows={5}
              placeholder={`Jane Doe\nHead of Partnerships, Acme\nacme.com`}
              value={signatureForm.signature_block}
              onChange={(e) =>
                setSignatureForm({ signature_block: e.target.value })
              }
              disabled={signatureStatus.state === "saving"}
            />
            <p className="text-[11px] text-muted-foreground">
              Shown at the bottom of replies you send from the portal.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-3 border-t border-border/30">
            <Button
              onClick={handleSaveSignature}
              disabled={signatureStatus.state === "saving"}
              className="gap-1.5"
              style={{ background: "#2E37FE" }}
            >
              <Save size={14} />
              {signatureStatus.state === "saving" ? "Saving…" : "Save"}
            </Button>
            <SaveStatus status={signatureStatus} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
