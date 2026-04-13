"use client";

import { useState, useEffect } from "react";
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
import { Building2, UserPlus, Shield, User } from "lucide-react";
import type { Profile } from "@/types/app";

export default function TeamPage() {
  const [members, setMembers] = useState<Profile[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("va");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
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

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/invite", {
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EBF5FE 0%, #D6ECFB 50%, #fff 100%)', border: '1px solid rgba(30,143,232,0.2)', borderTop: '1px solid rgba(30,143,232,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(30,143,232,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Settings</p>
          <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Team Management</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            {members.length} team member{members.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(71,165,237,0.06)]" />
      </div>

      {/* Invite Form */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10">
            <UserPlus size={16} className="text-[#1E8FE8]" />
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
            <Button type="submit" disabled={loading} style={{ background: '#1E8FE8' }}>
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
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10">
            <Building2 size={16} className="text-[#1E8FE8]" />
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
                  className="flex items-center justify-between rounded-xl border border-border/50 p-4 transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: '#1E8FE8' }}>
                      {(member.full_name || member.email).charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium">
                        {member.full_name || member.email}
                      </p>
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={
                        member.role === "owner"
                          ? "bg-[#1E8FE8]/20 text-[#47A5ED] border border-[#1E8FE8]/20"
                          : "badge-blue"
                      }
                    >
                      {member.role === "owner" ? <Shield size={11} className="mr-1" /> : <User size={11} className="mr-1" />}
                      {member.role === "owner" ? "Admin" : "VA"}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={
                        member.is_active
                          ? "badge-green"
                          : "badge-red"
                      }
                    >
                      {member.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
