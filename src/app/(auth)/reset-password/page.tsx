"use client";

import { useState } from "react";
import Link from "next/link";
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
import { Mail, ArrowLeft, CheckCircle } from "lucide-react";
import Image from "next/image";
import leadstartLogo from "../../../../public/leadstart-logo.png";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send reset email");
      }

      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Left panel - branding */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)' }}>
        <div className="relative z-10 max-w-md px-8 text-[#0f172a]">
          <div className="mb-8">
            <Image src={leadstartLogo} alt="LeadStart" priority className="h-16 w-auto" />
          </div>
          <h2 className="text-3xl font-bold leading-tight">
            Reset your password
          </h2>
          <p className="mt-4 text-lg text-[#0f172a]/70 leading-relaxed">
            We'll send you a secure link to reset your password and get back to your dashboard.
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
              <Image src={leadstartLogo} alt="LeadStart" priority className="h-12 w-auto" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {sent ? "Check your email" : "Forgot password?"}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {sent
                ? "We sent a password reset link to your email"
                : "Enter your email and we'll send you a reset link"
              }
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="space-y-4">
                <div className="flex justify-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
                    <CheckCircle size={32} className="text-emerald-500" />
                  </div>
                </div>
                <p className="text-sm text-center text-muted-foreground">
                  If an account exists for <strong>{email}</strong>, you'll receive an email with a link to reset your password.
                </p>
                <Link href="/login">
                  <Button variant="outline" className="w-full mt-2">
                    <ArrowLeft size={14} className="mr-2" />
                    Back to Sign In
                  </Button>
                </Link>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-4">
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
                  {loading ? "Sending..." : "Send Reset Link"}
                </Button>
                <Link href="/login" className="block">
                  <Button variant="ghost" className="w-full text-muted-foreground">
                    <ArrowLeft size={14} className="mr-2" />
                    Back to Sign In
                  </Button>
                </Link>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
