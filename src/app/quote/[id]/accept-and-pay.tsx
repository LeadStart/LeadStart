"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Lock, Loader2, X } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { loadStripe, type StripeEmbeddedCheckout } from "@stripe/stripe-js";

/**
 * Accept & pay on the hosted quote page.
 *
 * POSTs to the accept endpoint, which records the acceptance audit and creates
 * an EMBEDDED Stripe Checkout session. On success we open an on-site modal and
 * mount Stripe's embedded checkout inside it: the recipient never leaves the
 * quote page. Stripe redirects to the welcome page once payment completes. In
 * demo mode (no key) we fall back to a direct redirect to the welcome page.
 */
export function AcceptAndPay({
  quoteId,
  token,
}: {
  quoteId: string;
  token: string;
}) {
  const [status, setStatus] = useState<"idle" | "submitting" | "open">("idle");
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<StripeEmbeddedCheckout | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (
      status === "open" &&
      checkout &&
      containerRef.current &&
      !mountedRef.current
    ) {
      mountedRef.current = true;
      checkout.mount(containerRef.current);
    }
  }, [status, checkout]);

  const closeModal = useCallback(() => {
    try {
      checkout?.destroy();
    } catch {
      /* already destroyed */
    }
    mountedRef.current = false;
    setCheckout(null);
    setStatus("idle");
  }, [checkout]);

  async function handleAccept() {
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/billing/quotes/${quoteId}/accept`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(payload.error || "Unable to start checkout. Try again.");
        setStatus("idle");
        return;
      }
      const data = (await res.json()) as {
        client_secret?: string | null;
        publishable_key?: string | null;
        demo_redirect_url?: string | null;
      };

      // Demo mode (no Stripe key): no real checkout, go straight to welcome.
      if (!data.client_secret || !data.publishable_key) {
        if (data.demo_redirect_url) {
          window.location.href = data.demo_redirect_url;
          return;
        }
        setError("Checkout is not configured.");
        setStatus("idle");
        return;
      }

      const stripe = await loadStripe(data.publishable_key);
      if (!stripe) {
        setError("Could not load Stripe. Try again.");
        setStatus("idle");
        return;
      }
      const instance = await stripe.createEmbeddedCheckoutPage({
        clientSecret: data.client_secret,
      });
      mountedRef.current = false;
      setCheckout(instance);
      setStatus("open");
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
        ) : (
          <>
            <Lock size={14} className="mr-2" />
            Accept &amp; pay
          </>
        )}
      </Button>
      <p className="text-xs text-muted-foreground">
        Secure checkout powered by Stripe, right here on this page. Your card is
        charged the one-time total on acceptance; the monthly Lead management
        subscription begins on launch day.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}

      {status === "open" && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
        >
          <div className="my-8 w-full max-w-lg rounded-2xl border-t-[3px] border-[#2E37FE] bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <div className="text-sm font-semibold text-[#0f172a]">
                Complete your payment
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="cursor-pointer text-slate-400 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-2 sm:p-3">
              <div ref={containerRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
