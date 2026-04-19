import "server-only";
import Stripe from "stripe";

// Pinned to the SDK's ApiVersion constant so types and runtime stay aligned.
// Stripe SDK 22.x pins "2026-03-25.dahlia".
const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

/**
 * True when we should skip real Stripe API calls and return deterministic
 * fakes. Mirrors the Supabase demo-mode pattern in `src/lib/supabase/server.ts`.
 * Any billing helper that would hit Stripe must guard on this first.
 */
export function isStripeDemoMode(): boolean {
  if (process.env.DEMO_MODE === "true") return true;
  if (!process.env.STRIPE_SECRET_KEY) return true;
  return false;
}

/**
 * True when Stripe is configured with live-mode keys (`sk_live_…`).
 * Used by the admin UI to surface a "Live" vs "Test" banner.
 */
export function isStripeLiveMode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return !!key && key.startsWith("sk_live_");
}

let cached: Stripe | null = null;

/**
 * Returns the shared Stripe client. Throws if called in demo mode or without
 * a key — callers must check `isStripeDemoMode()` first and route demo paths
 * through the fakes in `src/lib/stripe/helpers.ts` (added in commit #3).
 */
export function getStripe(): Stripe {
  if (isStripeDemoMode()) {
    throw new Error(
      "getStripe() called while DEMO_MODE=true or STRIPE_SECRET_KEY unset. " +
        "Guard with isStripeDemoMode() before calling, or route through the demo helpers.",
    );
  }
  if (!cached) {
    cached = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
      appInfo: {
        name: "LeadStart",
        url: "https://leadstart-ebon.vercel.app",
      },
    });
  }
  return cached;
}

/**
 * Public URL for the app, used for Stripe Checkout success/cancel URLs and
 * the hosted quote page. In Vercel production this is set automatically via
 * `NEXT_PUBLIC_APP_URL`; locally it falls back to localhost on the basePath.
 */
export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000/app";
}
