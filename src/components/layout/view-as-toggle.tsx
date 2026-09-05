"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { appUrl } from "@/lib/api-url";

/**
 * The two-way view switch in the profile dropdown (src/lib/auth/view-as.ts).
 *
 * In the admin portal it reads "View as client" and drops you into a client's
 * real portal. Inside that preview it reads "Back to admin view" and takes you
 * out. One click each way, no picker: POSTing an empty body lets the server
 * choose a default client, and the banner's switcher changes which one.
 */
export function ViewAsToggle({ viewingAsClient }: { viewingAsClient: boolean }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (viewingAsClient) {
        await fetch(appUrl("/api/admin/view-as"), { method: "DELETE" });
        router.push("/admin");
      } else {
        const res = await fetch(appUrl("/api/admin/view-as"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error("Couldn't switch to client view", {
            description: data.error || `Request failed (${res.status})`,
          });
          return;
        }
        router.push("/client");
      }
      // refresh() re-runs the server layout so the shell swaps portals as part
      // of this same navigation rather than a beat later.
      router.refresh();
    } catch {
      toast.error("Couldn't switch views");
    } finally {
      // Always clear: the Topbar survives the admin <-> client navigation, so
      // relying on unmount to reset this left the item permanently disabled.
      setBusy(false);
    }
  }

  const Icon = viewingAsClient ? Undo2 : Eye;
  const label = viewingAsClient ? "Back to admin view" : "View as client";

  return (
    // NOTE: onClick, not onSelect. These menu items are Base UI
    // (@base-ui/react), whose MenuItem exposes `onClick` + `closeOnClick`.
    // `onSelect` is the Radix API; on a Base UI item it lands on the
    // underlying div as React's text-selection handler and never fires.
    <DropdownMenuItem onClick={() => void toggle()} disabled={busy}>
      <Icon size={14} className="mr-2" />
      {busy ? "Switching…" : label}
    </DropdownMenuItem>
  );
}
