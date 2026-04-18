"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { appUrl } from "@/lib/api-url";

export function InviteClientButton({
  clientId,
  clientEmail,
}: {
  clientId: string;
  clientEmail: string;
}) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInvite() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(appUrl("/api/invite"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: clientEmail,
          role: "client",
          client_id: clientId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send invite");
      }

      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <Button variant="outline" disabled>
        Invite Sent
      </Button>
    );
  }

  return (
    <div>
      <Button onClick={handleInvite} disabled={loading}>
        {loading ? "Sending..." : "Invite to Portal"}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
