"use client";

// Public self-serve buyer signup. Posts to the service-role /api/signup route
// (the only signup path, Supabase public signup is disabled). Includes the
// Turnstile widget, which renders nothing until a site key is configured, so the
// form works today and gains the challenge the moment keys are set.

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import leadstartMark from "../../../../public/leadstart-mark-transparent.png";
import { appUrl } from "@/lib/api-url";
import { TurnstileWidget } from "@/components/security/turnstile-widget";

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("submitting");
    try {
      const res = await fetch(appUrl("/api/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName,
          company,
          email,
          password,
          turnstileToken,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setStatus("idle");
        return;
      }
      setStatus("done");
    } catch {
      setError("Network error. Please try again.");
      setStatus("idle");
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{ background: "linear-gradient(135deg,#EEF0FF 0%,#F4F5F9 40%,#FFFFFF 100%)" }}
    >
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 pb-6">
          <Image src={leadstartMark} alt="LeadStart" priority className="h-14 w-auto" />
          <h1 className="text-xl font-bold tracking-tight text-foreground">Create your account</h1>
          <p className="text-sm text-muted-foreground">Self-serve contact sourcing, charged only on delivered contacts.</p>
        </div>

        <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
          {status === "done" ? (
            <div className="space-y-3 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary text-2xl">
                &#10003;
              </div>
              <h2 className="text-lg font-semibold text-foreground">Check your email</h2>
              <p className="text-sm text-muted-foreground">
                We sent a confirmation link to <strong>{email}</strong>. Click it to activate your
                account, then sign in.
              </p>
              <Link href="/login" className="inline-block pt-2 text-sm font-medium text-primary hover:underline">
                Go to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="full_name" className="mb-1 block text-sm font-medium text-foreground">
                  Full name
                </label>
                <input
                  id="full_name"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  autoComplete="name"
                />
              </div>
              <div>
                <label htmlFor="company" className="mb-1 block text-sm font-medium text-foreground">
                  Company <span className="text-muted-foreground">(optional)</span>
                </label>
                <input
                  id="company"
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  autoComplete="organization"
                />
              </div>
              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground">
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  autoComplete="email"
                />
              </div>
              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-medium text-foreground">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  autoComplete="new-password"
                />
                <p className="mt-1 text-xs text-muted-foreground">At least 8 characters.</p>
              </div>

              <TurnstileWidget onToken={setTurnstileToken} />

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={status === "submitting"}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {status === "submitting" ? "Creating account…" : "Create account"}
              </button>
            </form>
          )}
        </div>

        <p className="pt-4 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
