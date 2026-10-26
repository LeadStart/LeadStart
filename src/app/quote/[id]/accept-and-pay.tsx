"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
  const mountedRef = useRef(false);

  // The checkout mounts into its box as soon as the popup puts the box on the
  // page (the popup's portal can attach it a frame after it opens).
  const checkoutBox = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && checkout && !mountedRef.current) {
        mountedRef.current = true;
        checkout.mount(el);
      }
    },
    [checkout],
  );

  // Every way out (the X, a tap outside, Esc, a pull on a phone) closes the popup;
  // the checkout is taken down once its way out has finished, so it never
  // vanishes mid-motion.
  const closeModal = useCallback(() => setStatus("idle"), []);
  const afterClose = useCallback(
    (open: boolean) => {
      if (open) return;
      try {
        checkout?.destroy();
      } catch {
        /* already destroyed */
      }
      mountedRef.current = false;
      setCheckout(null);
    },
    [checkout],
  );

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

      <Dialog
        open={status === "open"}
        onOpenChange={(open) => !open && closeModal()}
        onOpenChangeComplete={afterClose}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-lg gap-0 overflow-hidden border-t-[3px] border-t-primary p-0 sm:max-w-lg"
        >
          <div className="flex items-center justify-between border-b border-border-soft px-5 py-3.5">
            <DialogTitle className="pr-0 text-sm">Complete your payment</DialogTitle>
            <DialogClose
              aria-label="Close"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X size={18} />
            </DialogClose>
          </div>
          <div className="p-2 sm:p-3">
            <div ref={checkoutBox} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
