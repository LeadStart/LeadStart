"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, X, ChevronDown, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { appUrl } from "@/lib/api-url";

interface PreviewClient {
  id: string;
  name: string;
}

/**
 * Persistent bar shown across the top of the shell while an admin is previewing
 * a client's portal (src/lib/auth/view-as.ts).
 *
 * It is the ONLY on-screen cue that you're not looking at your own account,
 * because every other piece of admin chrome is deliberately hidden so the
 * preview stays faithful. So it is pinned rather than scrolling away, and it
 * owns both the way out and the switch to a different client (the header
 * toggle lands on a default, and this is how you get to any other one).
 */
export function ViewAsBanner({ clientName }: { clientName: string | null }) {
  const [exiting, setExiting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [clients, setClients] = useState<PreviewClient[]>([]);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    fetch(appUrl("/api/admin/view-as"))
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => {
        if (alive) setClients((d.clients as PreviewClient[]) ?? []);
      })
      .catch(() => {
        /* switcher is a convenience; the exit path must never depend on it */
      });
    return () => {
      alive = false;
    };
  }, []);

  async function exitPreview() {
    if (exiting) return;
    setExiting(true);
    try {
      await fetch(appUrl("/api/admin/view-as"), { method: "DELETE" });
      router.push("/admin");
      router.refresh();
    } catch {
      setExiting(false);
    }
  }

  async function switchTo(clientId: string) {
    if (switching) return;
    setSwitching(true);
    try {
      await fetch(appUrl("/api/admin/view-as"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      // Back to the portal home: the current page may be a deep link that does
      // not exist for the client we just switched to.
      router.push("/client");
      router.refresh();
    } finally {
      setSwitching(false);
    }
  }

  const others = clients.filter((c) => c.name !== clientName);

  return (
    <div className="sticky top-0 z-50 flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-white sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Eye size={15} className="shrink-0" />
        {/* The client NAME is the one thing that must survive a narrow screen,
            so the framing words and the two action labels all give way first. */}
        <p className="truncate text-sm font-medium">
          <span className="hidden sm:inline">Viewing as </span>
          <span className="font-semibold">{clientName ?? "this client"}</span>
          <span className="hidden md:inline"> (read-only preview)</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Switch client"
              className="flex cursor-pointer items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-xs font-semibold outline-none transition-colors hover:bg-white/30 disabled:opacity-60 sm:px-2.5"
            >
              <Users size={13} className="sm:hidden" />
              <span className="hidden sm:inline">Switch client</span>
              <ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {clients.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  disabled={switching || c.name === clientName}
                  onClick={() => void switchTo(c.id)}
                >
                  {c.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button
          onClick={exitPreview}
          disabled={exiting}
          className="flex cursor-pointer items-center gap-1.5 rounded-md bg-white/20 px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-white/30 disabled:opacity-60"
        >
          <X size={13} />
          {exiting ? "Exiting…" : (
            <>
              Exit<span className="hidden sm:inline"> preview</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
