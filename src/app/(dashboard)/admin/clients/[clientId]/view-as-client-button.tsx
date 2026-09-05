"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { appUrl } from "@/lib/api-url";

/**
 * Opens this client's real portal as a read-only preview
 * (src/lib/auth/view-as.ts). The route sets an httpOnly cookie after checking
 * the client is in your org; the middleware then lets you past the /client
 * boundary and the portal renders their data under your own RLS.
 */
export function ViewAsClientButton({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [starting, setStarting] = useState(false);
  const router = useRouter();

  async function startPreview() {
    if (starting) return;
    setStarting(true);
    try {
      const res = await fetch(appUrl("/api/admin/view-as"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Couldn't open the portal preview", {
          description: data.error || `Request failed (${res.status})`,
        });
        setStarting(false);
        return;
      }
      // refresh() so the server layout re-reads the cookie and swaps the shell
      // into client mode as part of this navigation.
      router.push("/client");
      router.refresh();
    } catch {
      toast.error("Couldn't open the portal preview");
      setStarting(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={startPreview}
      disabled={starting}
      className="gap-1.5"
      title={`See the portal exactly as ${clientName} sees it`}
    >
      <Eye size={14} />
      {starting ? "Opening…" : "View as client"}
    </Button>
  );
}
