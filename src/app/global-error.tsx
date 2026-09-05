"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Poppins, JetBrains_Mono } from "next/font/google";
import { AlertTriangle } from "lucide-react";
import "./globals.css";

// This boundary REPLACES the root layout when the layout itself fails, so it
// owns <html>/<body> and declares the font + global styles itself (mirroring
// src/app/layout.tsx). Metadata exports are not supported here; React hoists
// the <title> below into <head>.
//
// Both font declarations must stay in lockstep with src/app/layout.tsx. The
// mono one is not decorative: the digest below renders with `font-mono`, which
// resolves to var(--font-geist-mono). Without this declaration that variable is
// undefined here, the font-family declaration is invalid at computed-value
// time, and the digest silently inherits Poppins instead.
const poppins = Poppins({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

type Props = { error: Error & { digest?: string }; reset: () => void; unstable_retry?: () => void };

const primaryBtn = "inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90";
const outlineBtn = "inline-flex h-9 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted";

export default function GlobalError({ error, reset, unstable_retry }: Props) {
  useEffect(() => {
    console.error(`[global-error] digest=${error.digest ?? "none"}`, error);
  }, [error]);

  const retry = unstable_retry ?? reset;

  return (
    <html
      lang="en"
      className={`${poppins.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-screen items-center justify-center p-6 font-sans">
        <title>Something went wrong | LeadStart</title>
        <main className="w-full max-w-md rounded-xl border bg-card p-6 text-sm">
          <div className="mb-3 inline-flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle size={18} />
          </div>
          <h1 className="font-heading text-base font-medium">Something went wrong</h1>
          <p className="mt-1 text-muted-foreground">LeadStart hit an unexpected error and could not load this page.</p>
          {error.digest && (
            <p className="mt-3 text-xs text-muted-foreground">
              Error reference: <code className="font-mono">{error.digest}</code>
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => retry()} className={primaryBtn}>
              Try again
            </button>
            <Link href="/" className={outlineBtn}>
              Go to home
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
