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
import { Mail, Lock, CheckCircle } from "lucide-react";

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  async function handleUpdate(e: React.FormEvent) {
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
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);

    // Redirect to dashboard after 2 seconds
    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 2000);
  }

  return (
    <div className="flex min-h-screen">
      {/* Left panel - branding */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)' }}>
        <div className="relative z-10 max-w-md px-8 text-white">
          <div className="flex items-center gap-3 mb-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 backdrop-blur-sm">
              <Mail size={20} className="text-white" />
            </div>
            <span className="text-2xl font-bold tracking-tight">LeadStart</span>
          </div>
          <h2 className="text-3xl font-bold leading-tight">
            Set your new password
          </h2>
          <p className="mt-4 text-lg text-white/70 leading-relaxed">
            Choose a strong password to secure your LeadStart account.
          </p>
        </div>
        <div className="absolute -top-20 -right-20 h-64 w-64 rounded-full bg-white/5" />
        <div className="absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-white/5" />
      </div>

      {/* Right panel - form */}
      <div className="flex w-full lg:w-1/2 items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="flex justify-center lg:hidden mb-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
                  <Mail size={16} className="text-white" />
                </div>
                <span className="text-xl font-bold text-indigo-600">LeadStart</span>
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">
              {success ? "Password updated!" : "New password"}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {success
                ? "Redirecting you to your dashboard..."
                : "Enter your new password below"
              }
            </CardDescription>
          </CardHeader>
          <CardContent>
            {success ? (
              <div className="space-y-4">
                <div className="flex justify-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
                    <CheckCircle size={32} className="text-emerald-500" />
                  </div>
                </div>
                <p className="text-sm text-center text-muted-foreground">
                  Your password has been updated. Taking you to your dashboard now...
                </p>
              </div>
            ) : (
              <form onSubmit={handleUpdate} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-sm font-medium">New Password</Label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type="password"
                      placeholder="Min 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
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
                      placeholder="Re-enter password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
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
                  className="w-full bg-indigo-600 hover:opacity-90 transition-opacity font-medium"
                  disabled={loading}
                >
                  {loading ? "Updating..." : "Update Password"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
