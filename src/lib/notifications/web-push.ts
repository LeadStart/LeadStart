// Server-side web-push sender for hot-lead reply notifications. Self-guarded:
// every public entry point swallows its own errors so it can NEVER break the
// classification / client-email path in src/lib/replies/pipeline.ts.
//
// Config: VAPID keys via env (NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
// + optional VAPID_SUBJECT). If they're unset, every send silently no-ops —
// the feature is off until the keys land, exactly like the Resend path.

import webpush from "web-push";
import type { createAdminClient } from "@/lib/supabase/admin";

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:daniel@leadstart.io",
      publicKey,
      privateKey,
    );
    configured = true;
  } catch (err) {
    console.error("[web-push] setVapidDetails failed:", err);
    configured = false;
  }
  return configured;
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

function buildSnippet(subject: string | null, body: string | null): string {
  const base = (body || subject || "").replace(/\s+/g, " ").trim();
  if (!base) return "Tap to open the reply.";
  return base.length > 140
    ? base.slice(0, 140).replace(/\s+\S*$/, "") + "…"
    : base;
}

/**
 * Fan a hot-lead push out to every subscription in the org. Never throws.
 * No-ops when VAPID isn't configured, the org is unknown, or nobody's
 * subscribed. Prunes dead endpoints (404/410) as it goes.
 */
export async function sendHotLeadPush(args: {
  admin: ReturnType<typeof createAdminClient>;
  organizationId: string | null;
  replyId: string;
  leadName: string | null;
  leadCompany: string | null;
  replySubject: string | null;
  replyBodyText: string | null;
  finalClass: string;
}): Promise<void> {
  try {
    if (!args.organizationId) return;
    if (!ensureConfigured()) return;

    const { data: subs, error } = await args.admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("organization_id", args.organizationId);
    if (error) {
      console.error("[web-push] load subscriptions failed:", error);
      return;
    }
    if (!subs || subs.length === 0) return;

    const name = args.leadName || "A lead";
    const where = args.leadCompany ? ` (${args.leadCompany})` : "";
    const payload: PushPayload = {
      title: `🔥 ${name}${where} replied`,
      body: buildSnippet(args.replySubject, args.replyBodyText),
      url: `/app/admin/inbox/${args.replyId}`,
      tag: `reply-${args.replyId}`,
    };
    const body = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: s.endpoint as string,
              keys: { p256dh: s.p256dh as string, auth: s.auth as string },
            },
            body,
          );
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // Endpoint is gone — prune so we stop trying.
            await args.admin
              .from("push_subscriptions")
              .delete()
              .eq("id", s.id as string);
          } else {
            console.error("[web-push] send failed:", err);
          }
        }
      }),
    );
  } catch (err) {
    console.error("[web-push] sendHotLeadPush failed (non-fatal):", err);
  }
}
