"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lock, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

/**
 * Accept & pay button on the hosted quote page.
 *
 * POSTs to the accept endpoint, which records the acceptance audit and
 * creates a Stripe Checkout session (or a demo session in demo mode). On
 * success we redirect the recipient directly to the Checkout URL.
 */
export function AcceptAndPay({
  quoteId,
  token,
}: {
  quoteId: string;
  token: string;
}) {
  const [status, setStatus] = useState<"idle" | "submitting" | "redirecting">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(
        appUrl(`/api/billing/quotes/${quoteId}/accept`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(payload.error || "Unable to start checkout. Try again.");
        setStatus("idle");
        return;
      }
      const { checkout_url } = (await res.json()) as {
        checkout_url: string;
      };
      setStatus("redirecting");
      window.location.href = checkout_url;
    } catch {
      setError("Network error. Try again.");
      setStatus("idle");
    }
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={handleAccept}
        disabled={status !== "idle"}
        style={{ background: "#2E37FE" }}
        className="w-full sm:w-auto"
      >
        {status === "submitting" ? (
          <>
            <Loader2 size={16} className="mr-2 animate-spin" />
            Starting checkout…
          </>
        ) : status === "redirecting" ? (
          <>
            <Loader2 size={16} className="mr-2 animate-spin" />
            Redirecting…
          </>
        ) : (
          <>
            <Lock size={14} className="mr-2" />
            Accept &amp; pay
          </>
        )}
      </Button>
      <p className="text-xs text-muted-foreground">
        Secure checkout powered by Stripe. Your card is charged the setup fee
        on acceptance; the monthly subscription begins after the 14-day warming
        period.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
