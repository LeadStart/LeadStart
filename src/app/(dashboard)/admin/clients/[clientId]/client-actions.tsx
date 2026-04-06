"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Pencil, X, Send, KeyRound, Mail } from "lucide-react";
import type { Client } from "@/types/app";

export function ClientActions({
  client,
  onEmailUpdated,
}: {
  client: Client;
  onEmailUpdated: (email: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(client.contact_email || "");
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedEmail, setSavedEmail] = useState(client.contact_email || "");

  async function saveEmail(newEmail: string) {
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("clients")
      .update({ contact_email: newEmail })
      .eq("id", client.id);

    if (updateError) throw new Error(updateError.message);

    setSavedEmail(newEmail);
    onEmailUpdated(newEmail);
  }

  async function handleSaveEmail() {
    if (!email.trim()) return;
    setSaving(true);
    setError(null);

    try {
      await saveEmail(email.trim());
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAndInvite() {
    if (!email.trim()) return;
    setSaving(true);
    setError(null);

    try {
      // Save email first
      await saveEmail(email.trim());

      // Then send invite
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          role: "client",
          client_id: client.id,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send invite");
      }

      setInvited(true);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleInvite() {
    setInviting(true);
    setError(null);

    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: savedEmail,
          role: "client",
          client_id: client.id,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send invite");
      }

      setInvited(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInviting(false);
    }
  }

  async function handleResetPassword() {
    setResetting(true);
    setError(null);

    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: savedEmail }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send reset email");
      }

      setResetSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(false);
    }
  }

  const hasPortal = !!client.user_id;

  // Client already has portal access
  if (hasPortal && !editing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Mail size={14} className="text-white/50" />
          <span className="text-sm text-white/70">{savedEmail}</span>
          <button
            onClick={() => setEditing(true)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Pencil size={11} />
          </button>
          <Badge className="bg-emerald-500/20 text-emerald-200 border-0 text-xs">Portal Active</Badge>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={handleResetPassword}
              disabled={resetting || resetSent}
              className="h-7 bg-white/10 border-white/20 text-white hover:bg-white/20 text-xs"
            >
              <KeyRound size={12} className="mr-1.5" />
              {resetSent ? "Reset Email Sent" : resetting ? "Sending..." : "Reset Password"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleInvite}
              disabled={inviting || invited}
              className="h-7 bg-white/10 border-white/20 text-white hover:bg-white/20 text-xs"
            >
              <Send size={12} className="mr-1.5" />
              {invited ? "Invite Re-sent" : inviting ? "Sending..." : "Re-send Invite"}
            </Button>
          </div>
        </div>
        {error && <p className="text-xs text-red-300 bg-red-500/20 rounded px-2 py-1">{error}</p>}
      </div>
    );
  }

  // Editing mode — type email, then save or save+invite
  if (editing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="client@company.com"
            className="h-8 w-64 bg-white/10 border-white/20 text-white placeholder:text-white/40 text-sm"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveAndInvite(); }}
          />
          <Button
            size="sm"
            onClick={handleSaveAndInvite}
            disabled={saving || !email.trim()}
            className="h-8 bg-white/20 hover:bg-white/30 text-white text-xs"
          >
            <Send size={12} className="mr-1.5" />
            {saving ? "Sending..." : "Save & Send Invite"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSaveEmail}
            disabled={saving || !email.trim()}
            className="h-8 text-white/60 hover:text-white hover:bg-white/10 text-xs"
          >
            Save Only
          </Button>
          <button
            onClick={() => { setEditing(false); setEmail(savedEmail); }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        {error && <p className="text-xs text-red-300 bg-red-500/20 rounded px-2 py-1">{error}</p>}
      </div>
    );
  }

  // Has saved email but no portal yet
  if (savedEmail) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Mail size={14} className="text-white/50" />
          <span className="text-sm text-white/70">{savedEmail}</span>
          <button
            onClick={() => setEditing(true)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Pencil size={11} />
          </button>
          {invited ? (
            <Badge className="bg-emerald-500/20 text-emerald-200 border-0 text-xs ml-auto">Invite Sent</Badge>
          ) : (
            <Button
              size="sm"
              onClick={handleInvite}
              disabled={inviting}
              className="h-7 bg-white/20 hover:bg-white/30 text-white text-xs ml-auto"
            >
              <Send size={12} className="mr-1.5" />
              {inviting ? "Sending..." : "Send Portal Invite"}
            </Button>
          )}
        </div>
        {error && <p className="text-xs text-red-300 bg-red-500/20 rounded px-2 py-1">{error}</p>}
      </div>
    );
  }

  // No email set — prompt to add one
  return (
    <div className="space-y-2">
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-2 text-sm text-white/50 hover:text-white transition-colors"
      >
        <Mail size={14} />
        <span>Add client email to send portal invite</span>
        <Pencil size={11} />
      </button>
      {error && <p className="text-xs text-red-300 bg-red-500/20 rounded px-2 py-1">{error}</p>}
    </div>
  );
}
