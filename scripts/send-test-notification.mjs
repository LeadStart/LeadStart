#!/usr/bin/env node
/**
 * Integration test for the hot-lead notification pipeline (commit #5).
 *
 * Fetches a seeded lead_replies row, then fires a REAL Resend email to the
 * client's notification_email (or TEST_NOTIFICATION_TO override). Also
 * writes notified_at + notification_token_hash to the row.
 *
 * Guarded behind SEND_TEST_NOTIFICATION=1 so accidental runs during
 * regular test cycles don't spam the owner's inbox.
 *
 * Usage:
 *   SEND_TEST_NOTIFICATION=1 npx tsx scripts/send-test-notification.mjs
 *   SEND_TEST_NOTIFICATION=1 TEST_NOTIFICATION_TO=you@example.com npx tsx scripts/send-test-notification.mjs
 *   SEND_TEST_NOTIFICATION=1 REPLY_ID=<uuid> npx tsx scripts/send-test-notification.mjs
 */

import { readFileSync, existsSync } from "node:fs";

if (process.env.SEND_TEST_NOTIFICATION !== "1") {
  console.error("Refusing to run without SEND_TEST_NOTIFICATION=1.");
  console.error("This script sends a REAL email via Resend.");
  process.exit(1);
}

function loadEnvLocal() {
  if (!existsSync(".env.local")) {
    console.error("No .env.local found. Needed for Supabase + Resend keys.");
    process.exit(1);
  }
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
loadEnvLocal();

for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "URL_SIGNING_SECRET",
  "NEXT_PUBLIC_APP_URL",
]) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

const { createAdminClient } = await import("../src/lib/supabase/admin.ts");
const { sendHotLeadNotification } = await import(
  "../src/lib/notifications/send-hot-lead.ts"
);

const admin = createAdminClient();

// 1. Pick the reply to use.
let reply;
if (process.env.REPLY_ID) {
  const { data, error } = await admin
    .from("lead_replies")
    .select("*")
    .eq("id", process.env.REPLY_ID)
    .maybeSingle();
  if (error || !data) {
    console.error(`Could not fetch lead_replies row ${process.env.REPLY_ID}:`, error);
    process.exit(1);
  }
  reply = data;
} else {
  // Prefer a hot-classified row if one exists, otherwise fall back to any row.
  // We don't need final_class for the email to render — the template handles null.
  const { data, error } = await admin
    .from("lead_replies")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    console.error("No lead_replies rows found. Run scripts/seed-dev-replies.mjs first.");
    process.exit(1);
  }
  reply = data;
}

console.log(`Using reply ${reply.id} — ${reply.lead_name || reply.lead_email}`);

// 2. Resolve the recipient.
let to;
if (process.env.TEST_NOTIFICATION_TO) {
  to = process.env.TEST_NOTIFICATION_TO;
  console.log(`Recipient override: ${to}`);
} else {
  const { data: client, error } = await admin
    .from("clients")
    .select("id, name, notification_email")
    .eq("id", reply.client_id)
    .maybeSingle();
  if (error || !client) {
    console.error("Could not fetch client for reply:", error);
    process.exit(1);
  }
  if (!client.notification_email) {
    console.error(
      `Client "${client.name}" has no notification_email set. ` +
        `Populate clients.notification_email or pass TEST_NOTIFICATION_TO=...`
    );
    process.exit(1);
  }
  to = client.notification_email;
  console.log(`Recipient (from clients.notification_email): ${to}`);
}

// 3. If the row already has notified_at, we'd skip — reset it so the test
//    actually sends. The token hash will be overwritten by the send.
if (reply.notified_at) {
  console.log(`Row already has notified_at=${reply.notified_at}; clearing for test.`);
  await admin
    .from("lead_replies")
    .update({
      notified_at: null,
      notification_token_hash: null,
      notification_token_consumed_at: null,
      notification_email_id: null,
    })
    .eq("id", reply.id);
  reply.notified_at = null;
  reply.notification_token_hash = null;
}

// 4. Fire.
console.log("Sending…");
const result = await sendHotLeadNotification(
  { reply, clientNotificationEmail: to },
  admin
);

console.log("Result:", result);
console.log("\n✓ Check the inbox at", to);
console.log(
  `  Dossier link uses /client/inbox/${reply.id}?token=... — token hash stored on the row.`
);
