"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Mail, Lock, User } from "lucide-react";

export default function AcceptInvitePage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // The invite link redirects here with a session already established
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }: { data: { user: unknown } }) => {
      if (user) {
        setReady(true);
      }
    });
  }, []);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    const supabase = createClient();

    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { full_name: fullName },
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-[#7A7872]">Verifying your invitation...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Left panel - branding */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)' }}>
        <div className="relative z-10 max-w-md px-8 text-[#0f172a]">
          <div className="flex items-center gap-3 mb-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur-sm">
              <Mail size={20} className="text-[#0f172a]" />
            </div>
            <span className="text-2xl font-bold tracking-tight">LeadStart</span>
          </div>
          <h2 className="text-3xl font-bold leading-tight">
            Welcome aboard.
          </h2>
          <p className="mt-4 text-lg text-[#0f172a]/70 leading-relaxed">
            Set up your account to access your campaign dashboard and start tracking results.
          </p>
        </div>
        <div className="absolute -top-20 -right-20 h-64 w-64 rounded-full bg-[rgba(107,114,255,0.06)]" />
        <div className="absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Right panel - form */}
      <div className="flex w-full lg:w-1/2 items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="flex justify-center lg:hidden mb-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                  <Mail size={16} className="text-[#0f172a]" />
                </div>
                <span className="text-xl font-bold text-[#2E37FE]">LeadStart</span>
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">
              Welcome to LeadStart
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Set up your account to get started
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSetPassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="fullName" className="text-sm font-medium">Full Name</Label>
                <div className="relative">
                  <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="John Doe"
                    className="pl-10"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    className="pl-10"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm Password</Label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    className="pl-10"
                    required
                  />
                </div>
              </div>
              {error && (
                <div className="rounded-lg bg-red-50 border border-red-500/20 p-3">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}
              <Button
                type="submit"
                className="w-full bg-[#2E37FE] text-white hover:bg-[#1C24B8] transition-colors font-medium"
                disabled={loading}
              >
                {loading ? "Setting up..." : "Complete Setup"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
