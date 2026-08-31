"use client";

// Cloudflare Turnstile widget — the client half of the bot gate. Pairs with
// verifyTurnstile() in src/lib/security/turnstile.ts.
//
// INERT UNTIL CONFIGURED: with no NEXT_PUBLIC_TURNSTILE_SITE_KEY set this renders
// nothing and never yields a token, so forms submit as before and the server
// skips verification (its secret is unset too). Once both keys are set the widget
// appears and hands the form a token to POST (as `turnstileToken`).
//
// Usage:
//   const [token, setToken] = useState<string | null>(null);
//   <TurnstileWidget onToken={setToken} />
//   ...include { turnstileToken: token } in the POST body.

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
      action?: string;
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __turnstileLoading?: boolean;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Load the Turnstile script once; resolve when window.turnstile is ready. */
function loadTurnstile(): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("no window"));
      return;
    }
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const onReady = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile script loaded but api missing"));
    };
    if (existing) {
      existing.addEventListener("load", onReady, { once: true });
      // If it already loaded before this component mounted.
      if (window.turnstile) onReady();
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener("error", () => reject(new Error("turnstile script failed to load")), {
      once: true,
    });
    document.head.appendChild(script);
  });
}

export interface TurnstileWidgetProps {
  onToken: (token: string | null) => void;
  theme?: "auto" | "light" | "dark";
  action?: string;
  className?: string;
}

export function TurnstileWidget({ onToken, theme = "auto", action, className }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    const el = containerRef.current;

    loadTurnstile()
      .then((api) => {
        if (cancelled || !el) return;
        widgetIdRef.current = api.render(el, {
          sitekey: siteKey,
          theme,
          action,
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch((err) => {
        console.error("[turnstile-widget]", err);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* widget already gone */
        }
        widgetIdRef.current = null;
      }
    };
    // Re-render only if the site key changes (stable in practice).
    // onToken/theme/action are treated as stable by callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={containerRef} className={className} />;
}
