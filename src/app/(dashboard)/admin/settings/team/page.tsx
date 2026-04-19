"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, UserPlus, Shield, User, Pencil, Trash2, Ban, Check, X, Bell, BellOff } from "lucide-react";
import type { Profile } from "@/types/app";
import { appUrl } from "@/lib/api-url";

export default function TeamPage() {
  const [members, setMembers] = useState<Profile[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("va");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("va");
  const [editSaving, setEditSaving] = useState(false);

  // Action states
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notifyTogglingId, setNotifyTogglingId] = useState<string | null>(null);

  const fetchMembers = useCallback(() => {
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .in("role", ["owner", "va"])
      .order("created_at")
      .then(({ data }: { data: unknown }) => {
        setMembers((data || []) as Profile[]);
      });
  }, []);

  useEffect(() => {
    fetchMembers();
    // Get current user ID for self-protection
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setCurrentUserId(session.user.id);
    });
  }, [fetchMembers]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch(appUrl("/api/invite"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send invite");
      }

      setSuccess(true);
      setEmail("");
      fetchMembers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function startEdit(member: Profile) {
    setEditingId(member.id);
    setEditName(member.full_name || "");
    setEditRole(member.role);
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    setEditSaving(true);
    try {
      const res = await fetch(appUrl("/api/admin/team"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: editingId, full_name: editName, role: editRole }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update");
      }
      setEditingId(null);
      fetchMembers();
    } catch {
      // silently fail
    } finally {
      setEditSaving(false);
    }
  }

  async function handleToggleActive(memberId: string, currentlyActive: boolean) {
    setTogglingId(memberId);
    try {
      const res = await fetch(appUrl("/api/admin/team"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: memberId, is_active: !currentlyActive }),
      });
      if (res.ok) fetchMembers();
    } catch {
      // silently fail
    } finally {
      setTogglingId(null);
    }
  }

  async function handleToggleNotifications(memberId: string, enabled: boolean) {
    setNotifyTogglingId(memberId);
    try {
      const res = await fetch(appUrl("/api/admin/team"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: memberId, receives_contact_notifications: enabled }),
      });
      if (res.ok) fetchMembers();
    } catch {
      // silently fail
    } finally {
      setNotifyTogglingId(null);
    }
  }

  async function handleRemove(memberId: string) {
    setRemovingId(memberId);
    try {
      const res = await fetch(appUrl("/api/admin/team"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: memberId }),
      });
      if (res.ok) fetchMembers();
    } catch {
      // silently fail
    } finally {
      setRemovingId(null);
      setConfirmRemoveId(null);
    }
  }

  const isSelf = (id: string) => id === currentUserId;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Settings</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Team Management</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            {members.length} team member{members.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Invite Form */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <UserPlus size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Invite Team Member</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="flex items-end gap-4">
            <div className="space-y-1 flex-1">
              <Label htmlFor="inviteEmail" className="text-sm font-medium">Email</Label>
              <Input
                id="inviteEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="va@example.com"
                required
              />
            </div>
            <div className="space-y-1 w-40">
              <Label className="text-sm font-medium">Role</Label>
              <Select value={role} onValueChange={(val) => setRole(val ?? "va")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="va">VA</SelectItem>
                  <SelectItem value="owner">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={loading} style={{ background: '#2E37FE' }}>
              {loading ? "Sending..." : "Send Invite"}
            </Button>
          </form>
          {error && (
            <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
          {success && (
            <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
              <p className="text-sm text-emerald-700">Invite sent!</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Team Members */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Building2 size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Team Members</CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team members yet.</p>
          ) : (
            <div className="space-y-2">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="rounded-xl border border-border/50 p-4 transition-colors hover:bg-muted/30"
                >
                  {editingId === member.id ? (
                    /* Edit mode */
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
                        {(member.full_name || member.email).charAt(0).toUpperCase()}
                      </div>
                      <div className="flex items-center gap-3 flex-1">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Full name"
                          className="h-8 w-48 text-sm"
                          autoFocus
                        />
                        {!isSelf(member.id) && (
                          <Select value={editRole} onValueChange={(val) => setEditRole(val ?? "va")}>
                            <SelectTrigger className="h-8 w-28 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="va">VA</SelectItem>
                              <SelectItem value="owner">Admin</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        <Button
                          size="sm"
                          onClick={handleSaveEdit}
                          disabled={editSaving}
                          className="h-8 text-xs"
                          style={{ background: '#2E37FE' }}
                        >
                          <Check size={12} className="mr-1" />
                          {editSaving ? "Saving..." : "Save"}
                        </Button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
                          {(member.full_name || member.email).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium">
                            {member.full_name || member.email}
                            {isSelf(member.id) && <span className="text-xs text-muted-foreground ml-2">(you)</span>}
                          </p>
                          <p className="text-xs text-muted-foreground">{member.email}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="secondary"
                          className={
                            member.role === "owner"
                              ? "bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20"
                              : "badge-blue"
                          }
                        >
                          {member.role === "owner" ? <Shield size={11} className="mr-1" /> : <User size={11} className="mr-1" />}
                          {member.role === "owner" ? "Admin" : "VA"}
                        </Badge>
                        <Badge
                          variant="secondary"
                          className={member.is_active ? "badge-green" : "badge-red"}
                        >
                          {member.is_active ? "Active" : "Inactive"}
                        </Badge>

                        {member.role === "owner" && (
                          <button
                            onClick={() =>
                              handleToggleNotifications(member.id, !member.receives_contact_notifications)
                            }
                            disabled={notifyTogglingId === member.id}
                            className={`flex items-center gap-1 px-2 h-6 rounded-md text-xs font-medium transition-colors ${
                              member.receives_contact_notifications
                                ? "bg-[#2E37FE]/15 text-[#2E37FE] hover:bg-[#2E37FE]/25"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                            }`}
                            title={
                              member.receives_contact_notifications
                                ? "Receives contact form emails — click to mute"
                                : "Muted — click to receive contact form emails"
                            }
                          >
                            {member.receives_contact_notifications ? <Bell size={11} /> : <BellOff size={11} />}
                            {member.receives_contact_notifications ? "Contact emails" : "Muted"}
                          </button>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center gap-1 ml-2">
                          <button
                            onClick={() => startEdit(member)}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="Edit"
                          >
                            <Pencil size={13} />
                          </button>

                          {!isSelf(member.id) && (
                            <>
                              <button
                                onClick={() => handleToggleActive(member.id, member.is_active)}
                                disabled={togglingId === member.id}
                                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                                  member.is_active
                                    ? "text-amber-500 hover:text-amber-600 hover:bg-amber-50"
                                    : "text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50"
                                }`}
                                title={member.is_active ? "Deactivate" : "Activate"}
                              >
                                {member.is_active ? <Ban size={13} /> : <Check size={13} />}
                              </button>

                              {confirmRemoveId === member.id ? (
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => handleRemove(member.id)}
                                    disabled={removingId === member.id}
                                    className="h-7 text-xs"
                                  >
                                    {removingId === member.id ? "..." : "Confirm"}
                                  </Button>
                                  <button
                                    onClick={() => setConfirmRemoveId(null)}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setConfirmRemoveId(member.id)}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                  title="Remove"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
