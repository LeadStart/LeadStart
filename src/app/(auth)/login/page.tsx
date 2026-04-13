"use client";

import { useState } from "react";
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
import { Mail, Lock } from "lucide-react";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.refresh();
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
            Cold email campaigns that convert.
          </h2>
          <p className="mt-4 text-lg text-[#0f172a]/70 leading-relaxed">
            Monitor performance, manage clients, and scale your outreach — all from one dashboard.
          </p>
          <div className="mt-8 flex gap-6 text-sm text-[#0f172a]/50">
            <div>
              <p className="text-2xl font-bold text-[#0f172a]">10K+</p>
              <p>Emails/month</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-[#0f172a]">6%+</p>
              <p>Reply rate</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-[#0f172a]">50+</p>
              <p>Meetings/mo</p>
            </div>
          </div>
        </div>
        {/* Decorative elements */}
        <div className="absolute -top-20 -right-20 h-64 w-64 rounded-full bg-[rgba(107,114,255,0.06)]" />
        <div className="absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-[rgba(107,114,255,0.06)]" />
        <div className="absolute top-1/3 right-1/4 h-32 w-32 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Right panel - form */}
      <div className="flex w-full lg:w-1/2 items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="flex justify-center lg:hidden mb-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
                  <Mail size={16} className="text-white" />
                </div>
                <span className="text-xl font-bold text-[#2E37FE] font-bold">LeadStart</span>
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
            <CardDescription className="text-muted-foreground">
              Sign in to your campaign dashboard
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                <div className="relative">
                  <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
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
                    className="pl-10"
                    required
                  />
                </div>
              </div>
              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}
              <Button
                type="submit"
                className="w-full bg-[#2E37FE] text-white hover:bg-[#1C24B8] transition-colors font-medium"
                disabled={loading}
              >
                {loading ? "Signing in..." : "Sign In"}
              </Button>
              <div className="text-center">
                <Link
                  href="/reset-password"
                  className="text-sm text-[#2E37FE] hover:text-[#6B72FF] transition-colors"
                >
                  Forgot your password?
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
