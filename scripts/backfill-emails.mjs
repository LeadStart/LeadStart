/**
 * One-time script: Pull reply email content from Instantly /emails API
 * and update webhook_events payload with reply_body, reply_subject, etc.
 *
 * Usage: node scripts/backfill-emails.mjs
 */

const BASE_URL = "https://api.instantly.ai/api/v2";
const API_KEY = "NzQ2MzMzMzQtZDI3OC00OWE4LTg5N2UtMmE5ZTdkYjllYTNmOlZ5Y1lRdFhSWUJhUg==";

const SUPABASE_URL = "https://exedxjrifprqgftyuroc.supabase.co";
// We need the service role key - check Vercel env or ask user
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error("ERROR: Set SUPABASE_SERVICE_ROLE_KEY env var before running.");
  console.error("  export SUPABASE_SERVICE_ROLE_KEY=eyJ...");
  console.error("  node scripts/backfill-emails.mjs");
  process.exit(1);
}

const campaignIds = [
  "1888d1d8-d840-4871-b373-aa40c4a4dd8d",
  "8e3454ae-7e08-4eab-a1fb-302ef7e26616",
  "30ac2d58-6bea-4ea1-ac51-3d6fb54bfde1",
];

async function instantlyRequest(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

async function supabaseRequest(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: method === "PATCH" ? "return=minimal" : "return=representation",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  }
  if (method === "GET") return res.json();
  return null;
}

async function main() {
  console.log("Starting email content backfill...\n");

  for (const campaignId of campaignIds) {
    console.log(`\n--- Campaign: ${campaignId} ---`);

    // 1. Pull received emails from Instantly
    let allEmails = [];
    let cursor;
    do {
      const params = new URLSearchParams({ campaign_id: campaignId, email_type: "received", limit: "100" });
      if (cursor) params.set("starting_after", cursor);
      const data = await instantlyRequest(`/emails?${params.toString()}`);
      const items = data.items || data || [];
      if (Array.isArray(items)) allEmails.push(...items);
      cursor = data.next_starting_after;
    } while (cursor);

    console.log(`  Fetched ${allEmails.length} received emails`);

    if (allEmails.length === 0) continue;

    // Log first email structure for debugging
    if (allEmails[0]) {
      console.log(`  Sample email keys: ${Object.keys(allEmails[0]).join(", ")}`);
      console.log(`  Sample from: ${allEmails[0].from_address_email}`);
      console.log(`  Sample subject: ${allEmails[0].subject}`);
      const sampleBody = allEmails[0].body;
      console.log(`  Sample body type: ${typeof sampleBody}, text length: ${(sampleBody?.text || sampleBody?.html || "").length}`);
    }

    // 2. Build map: lead email → reply data
    const replyMap = new Map();
    for (const email of allEmails) {
      const leadEmail = (email.from_address_email || "").toLowerCase();
      if (!leadEmail) continue;
      const existing = replyMap.get(leadEmail);
      if (!existing || new Date(email.timestamp_created) > new Date(existing.timestamp)) {
        // body can be an object { text, html } or a string
        let bodyText = "";
        if (typeof email.body === "object" && email.body !== null) {
          bodyText = email.body.html || email.body.text || "";
        } else if (typeof email.body === "string") {
          bodyText = email.body;
        }
        replyMap.set(leadEmail, {
          subject: email.subject || "",
          body: bodyText,
          preview: email.content_preview || "",
          from: email.from_address_email,
          timestamp: email.timestamp_created,
          threadId: email.thread_id || "",
        });
      }
    }

    console.log(`  Unique lead replies: ${replyMap.size}`);

    // 3. Get webhook_events for email_replied in this campaign
    const events = await supabaseRequest(
      "GET",
      `webhook_events?campaign_instantly_id=eq.${campaignId}&event_type=eq.email_replied&select=id,lead_email,payload`
    );

    console.log(`  Found ${events.length} email_replied events to update`);

    // 4. Update each event with reply content
    let updated = 0;
    for (const event of events) {
      const leadEmail = (event.lead_email || "").toLowerCase();
      const replyData = replyMap.get(leadEmail);
      if (!replyData) {
        console.log(`  ⚠ No reply found for ${leadEmail}`);
        continue;
      }

      const updatedPayload = {
        ...(event.payload || {}),
        reply_subject: replyData.subject,
        reply_body: replyData.body,
        reply_preview: replyData.preview,
        reply_from: replyData.from,
        reply_timestamp: replyData.timestamp,
        reply_thread_id: replyData.threadId,
      };

      await supabaseRequest("PATCH", `webhook_events?id=eq.${event.id}`, {
        payload: updatedPayload,
      });
      updated++;
      console.log(`  ✓ Updated ${leadEmail}`);
    }

    console.log(`  Updated ${updated}/${events.length} events`);
  }

  console.log("\n✅ Backfill complete!");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
