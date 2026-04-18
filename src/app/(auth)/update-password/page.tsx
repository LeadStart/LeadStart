"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import Image from "next/image";
import leadstartLogo from "../../../../public/leadstart-logo.png";
import { appUrl } from "@/lib/api-url";

export default function UpdatePasswordPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background"><p className="text-muted-foreground">Loading...</p></div>}>
      <UpdatePasswordForm />
    </Suspense>
  );
}

function UpdatePasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const email = searchParams.get("email");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  if (!token || !email) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-md border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-2xl font-bold">Link expired</CardTitle>
            <CardDescription>This reset link is no longer valid</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-red-50 border border-red-200 p-4 mb-4">
              <p className="text-sm text-red-700">
                This password reset link has expired or is invalid. Please request a new one.
              </p>
            </div>
            <Button
              onClick={() => router.push("/reset-password")}
              className="w-full bg-[#2E37FE] text-white hover:bg-[#1C24B8] transition-colors font-medium cursor-pointer"
            >
              Request New Reset Link
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

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
    try {
      const res = await fetch(appUrl("/api/reset-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update password");
      }
      setSuccess(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-md border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-2xl font-bold">Password updated!</CardTitle>
            <CardDescription>Redirecting to login...</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
                <CheckCircle size={32} className="text-emerald-500" />
              </div>
            </div>
            <p className="text-sm text-center text-muted-foreground mt-4">
              Your password has been updated. Taking you to login now...
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)' }}>
        <div className="relative z-10 max-w-md px-8 text-[#0f172a]">
          <div className="mb-8">
            <Image src={leadstartLogo} alt="LeadStart" priority className="h-16 w-auto" />
          </div>
          <h2 className="text-3xl font-bold leading-tight">Set your new password</h2>
          <p className="mt-4 text-lg text-[#0f172a]/70 leading-relaxed">
            Choose a strong password to secure your LeadStart account.
          </p>
        </div>
        <div className="absolute -top-20 -right-20 h-64 w-64 rounded-full bg-[rgba(107,114,255,0.06)]" />
        <div className="absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      <div className="flex w-full lg:w-1/2 items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border/50 shadow-lg">
          <CardHeader className="text-center pb-2">
            <div className="flex justify-center lg:hidden mb-4">
              <Image src={leadstartLogo} alt="LeadStart" priority className="h-12 w-auto" />
            </div>
            <CardTitle className="text-2xl font-bold">New password</CardTitle>
            <CardDescription className="text-muted-foreground">
              Enter a new password for <strong>{email}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleUpdate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium">New Password</Label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input id="password" type="password" placeholder="Min 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-10" required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm Password</Label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input id="confirmPassword" type="password" placeholder="Re-enter password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="pl-10" required />
                </div>
              </div>
              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}
              <Button type="submit" className="w-full bg-[#2E37FE] text-white hover:bg-[#1C24B8] transition-colors font-medium" disabled={loading}>
                {loading ? "Updating..." : "Update Password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
