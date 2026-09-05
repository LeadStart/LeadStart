"use client";

// Client helpers for the web-push opt-in: service-worker registration,
// permission, subscribe/unsubscribe, and reporting the current state.
//
// iOS note: web push only works inside the INSTALLED PWA (Add to Home Screen)
// on iOS 16.4+, and the permission prompt must come from a user gesture — so
// `enablePush()` is only ever called from a button/menu tap.

import { appUrl } from "@/lib/api-url";

// Served from public/sw.js; the app runs under basePath /app, so both the
// script and its scope live under /app.
const SW_URL = "/app/sw.js";
const SW_SCOPE = "/app/";

export type PushState =
  | "unsupported"
  | "denied"
  | "subscribed"
  | "unsubscribed";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// VAPID application server key: base64url → Uint8Array, as the Push API wants.
// Typed over ArrayBuffer (TS 5.7+ tracks the backing buffer) so the result
// satisfies the BufferSource that pushManager.subscribe() expects.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
}

export async function currentPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapid) return { ok: false, reason: "no_vapid_key" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission };

  try {
    const reg = await getRegistration();
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    });
    const json = sub.toJSON();
    const res = await fetch(appUrl("/api/push/subscribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    if (!res.ok) return { ok: false, reason: "save_failed" };
    return { ok: true };
  } catch (err) {
    console.error("[push] enable failed:", err);
    return { ok: false, reason: "error" };
  }
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    await fetch(appUrl("/api/push/unsubscribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  } catch (err) {
    console.error("[push] disable failed:", err);
  }
}
