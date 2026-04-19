"use client";

import { useEffect, useRef } from "react";
import { appUrl } from "@/lib/api-url";

export function ViewTracker({
  quoteId,
  token,
}: {
  quoteId: string;
  token: string;
}) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    fetch(appUrl(`/api/billing/quotes/${quoteId}/view`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      keepalive: true,
    }).catch(() => {
      // Best-effort — don't disturb the page on failure.
    });
  }, [quoteId, token]);

  return null;
}
