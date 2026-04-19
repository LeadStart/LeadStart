"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users, UserPlus, Send, KeyRound, Trash2, X, RefreshCw, Mail } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface LinkedUser {
  user_id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  invite_status: string;
}

export function ClientUsersSection({
  clientId,
  users,
  reportRecipients,
  onUsersChanged,
}: {
  clientId: string;
  users: LinkedUser[];
  // null means "no override set" — every portal user receives reports by default
  // (matches the convention in /admin/reports, where unset recipients = all checked).
  reportRecipients: string[] | null;
  onUsersChanged: () => void;
}) {
  // Local mirror so toggling is instant and doesn't require a full page reload.
  const [localRecipients, setLocalRecipients] = useState<string[] | null>(reportRecipients);
  const [togglingEmail, setTogglingEmail] = useState<string | null>(null);

  // If the parent re-fetches and the prop changes (e.g. edits elsewhere), re-sync.
  useEffect(() => {
    setLocalRecipients(reportRecipients);
  }, [reportRecipients]);

  function receives(email: string): boolean {
    // null = "all users receive by default" (matches admin/reports UI)
    if (localRecipients === null) return true;
    return localRecipients.includes(email);
  }

  async function handleToggleReports(email: string, next: boolean) {
    if (!email) return;
    // Materialize current list (all currently-checked emails) before mutating
    const currentEmails = new Set(
      localRecipients === null ? users.map((u) => u.email).filter(Boolean) : localRecipients,
    );
    if (next) currentEmails.add(email);
    else currentEmails.delete(email);

    const updated = [...currentEmails];
    const prev = localRecipients;
    setLocalRecipients(updated); // optimistic
    setTogglingEmail(email);

    try {
      const res = await fetch(appUrl("/api/admin/report-schedule"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, recipients: updated }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update recipients");
      }
    } catch (err) {
      setLocalRecipients(prev); // revert
      alert(`Couldn't update report recipients: ${(err as Error).message}`);
    } finally {
      setTogglingEmail(null);
    }
  }
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(false);

    try {
      const res = await fetch(appUrl("/api/invite"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: "client",
          client_id: clientId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to send invite");
      }

      setInviteSuccess(true);
      setInviteLink(data.invite_link || null);
      setInviteEmail("");
      onUsersChanged();
    } catch (err) {
      setInviteError((err as Error).message);
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(userId: string) {
    setRemovingId(userId);
    try {
      const res = await fetch(appUrl("/api/admin/client-users"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, user_id: userId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to remove user");
      }

      onUsersChanged();
    } catch {
      // silently fail
    } finally {
      setRemovingId(null);
      setConfirmRemoveId(null);
    }
  }

  async function handleResetPassword(email: string, userId: string) {
    setResettingId(userId);
    try {
      await fetch(appUrl("/api/reset-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // silently fail
    } finally {
      setResettingId(null);
    }
  }

  async function handleResendInvite(email: string, userId: string) {
    setResendingId(userId);
    try {
      await fetch(appUrl("/api/invite"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          role: "client",
          client_id: clientId,
        }),
      });
    } catch {
      // silently fail
    } finally {
      setResendingId(null);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
          <Users size={16} className="text-white" />
        </div>
        <CardTitle className="text-base flex-1">
          Portal Users ({users.length})
        </CardTitle>
        <Link
          href="/admin/reports"
          className="text-xs font-medium text-[#2E37FE] hover:underline flex items-center gap-1"
        >
          <Mail size={12} />
          Manage in Reports
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Existing users */}
        {users.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No users yet. Invite a client user to give them portal access.
          </p>
        ) : (
          <div className="space-y-2">
            {users.map((user) => (
              <div
                key={user.user_id}
                className="flex items-center justify-between rounded-xl border border-border/50 p-3 transition-colors hover:bg-muted/30"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: user.invite_status === "pending" ? '#9CA3AF' : '#2E37FE' }}>
                    {(user.full_name || user.email).charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">
                        {user.full_name || user.email}
                      </p>
                      {user.invite_status === "pending" && (
                        <Badge variant="secondary" className="badge-amber text-[10px] px-1.5 py-0">Pending</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label
                    className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors"
                    title={
                      receives(user.email)
                        ? "This user will receive scheduled KPI reports. Click to opt them out."
                        : "This user will NOT receive scheduled KPI reports. Click to opt them in."
                    }
                  >
                    <input
                      type="checkbox"
                      checked={receives(user.email)}
                      disabled={togglingEmail === user.email}
                      onChange={(e) => handleToggleReports(user.email, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border cursor-pointer accent-[#2E37FE]"
                    />
                    <Mail size={11} />
                    Reports
                  </label>
                  {user.invite_status === "pending" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleResendInvite(user.email, user.user_id)}
                      disabled={resendingId === user.user_id}
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <RefreshCw size={12} className="mr-1" />
                      {resendingId === user.user_id ? "Sent!" : "Resend"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleResetPassword(user.email, user.user_id)}
                      disabled={resettingId === user.user_id}
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <KeyRound size={12} className="mr-1" />
                      {resettingId === user.user_id ? "Sent" : "Reset Pwd"}
                    </Button>
                  )}
                  {confirmRemoveId === user.user_id ? (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleRemove(user.user_id)}
                        disabled={removingId === user.user_id}
                        className="h-7 text-xs"
                      >
                        {removingId === user.user_id ? "Removing..." : "Confirm"}
                      </Button>
                      <button
                        onClick={() => setConfirmRemoveId(null)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmRemoveId(user.user_id)}
                      className="h-7 text-xs text-red-500 hover:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 size={12} className="mr-1" />
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Invite form */}
        <form onSubmit={handleInvite} className="flex items-center gap-2 pt-2 border-t border-border/30">
          <UserPlus size={16} className="text-muted-foreground shrink-0" />
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => { setInviteEmail(e.target.value); setInviteSuccess(false); setInviteError(null); }}
            placeholder="user@company.com"
            className="h-8 flex-1 text-sm"
          />
          <Button
            type="submit"
            size="sm"
            disabled={inviting || !inviteEmail.trim()}
            className="h-8 text-xs"
            style={{ background: '#2E37FE' }}
          >
            <Send size={12} className="mr-1" />
            {inviting ? "Sending..." : "Invite"}
          </Button>
        </form>
        {inviteError && (
          <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">{inviteError}</p>
        )}
        {inviteSuccess && (
          <div className="text-xs text-emerald-600 bg-emerald-50 rounded px-2 py-1 space-y-1">
            <p>Invite sent! User created and linked.</p>
            {inviteLink && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Backup link:</span>
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(inviteLink); }}
                  className="underline hover:no-underline text-[#2E37FE]"
                >
                  Copy link
                </button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
