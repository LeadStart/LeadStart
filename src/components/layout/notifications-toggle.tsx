"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  currentPushState,
  enablePush,
  disablePush,
  type PushState,
} from "@/lib/push/client";

// A single dropdown item that lets a user turn hot-lead push notifications on
// or off for this device. Renders nothing on browsers that don't support push
// (older iOS Safari, non-installed iOS, etc.). Buzzes the phone when a hot lead
// replies — the "on the move" hook.
export function NotificationsToggle() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    currentPushState().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading" || state === "unsupported") return null;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (state === "subscribed") {
        await disablePush();
        setState("unsubscribed");
        toast.success("Reply notifications off");
      } else if (state === "denied") {
        toast.error("Notifications are blocked", {
          description:
            "Turn them on for this site in your browser or iOS settings.",
        });
      } else {
        const result = await enablePush();
        if (result.ok) {
          setState("subscribed");
          toast.success("Reply notifications on", {
            description: "You'll get a push the moment a hot lead replies.",
          });
        } else if (result.reason === "no_vapid_key") {
          toast.error("Notifications aren't configured yet", {
            description: "The server is missing its VAPID keys.",
          });
        } else if (result.reason === "denied" || result.reason === "default") {
          setState("denied");
          toast.error("Permission denied");
        } else if (result.reason === "unsupported") {
          toast.error("This device can't receive push", {
            description: "On iPhone, add the app to your Home Screen first.",
          });
        } else {
          toast.error("Couldn't enable notifications");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const label =
    state === "subscribed"
      ? "Reply notifications on"
      : state === "denied"
        ? "Notifications blocked"
        : "Enable reply notifications";
  const Icon =
    state === "subscribed" ? BellRing : state === "denied" ? BellOff : Bell;

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Keep the menu open so the label reflects the new state.
        e.preventDefault();
        void toggle();
      }}
      disabled={busy}
    >
      <Icon size={14} className="mr-2" />
      {label}
    </DropdownMenuItem>
  );
}
