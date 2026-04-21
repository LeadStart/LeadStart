/**
 * Dev-only seed script: populate lead_replies with a handful of realistic
 * hot/warm/silent entries so the /client/inbox page has something to render.
 *
 * Safe-ish against production — requires SEED_DEV_REPLIES=1 explicitly, prints
 * the target client + what it will insert, and inserts only test leads with
 * @example-inbound-test.com addresses so they're trivial to filter or purge.
 *
 * Usage:
 *   export SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *   SEED_DEV_REPLIES=1 node scripts/seed-dev-replies.mjs
 *
 * Cleanup:
 *   DELETE FROM lead_replies WHERE lead_email LIKE '%@example-inbound-test.com';
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://exedxjrifprqgftyuroc.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.env.SEED_DEV_REPLIES !== "1") {
  console.error("Refusing to run without SEED_DEV_REPLIES=1 set explicitly.");
  console.error("  SEED_DEV_REPLIES=1 node scripts/seed-dev-replies.mjs");
  process.exit(1);
}

if (!SUPABASE_SERVICE_KEY) {
  console.error("ERROR: set SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Target client: explicit override via CLIENT_ID, else first active client with a campaign.
const explicitClientId = process.env.CLIENT_ID;
let clientsQuery = supabase
  .from("clients")
  .select("id, organization_id, name");
if (explicitClientId) {
  clientsQuery = clientsQuery.eq("id", explicitClientId);
} else {
  clientsQuery = clientsQuery.eq("status", "active").limit(5);
}
const { data: clients, error: clientsErr } = await clientsQuery;

if (clientsErr) throw clientsErr;
if (!clients || clients.length === 0) {
  console.error(explicitClientId ? `No client with id ${explicitClientId}.` : "No active clients. Bailing.");
  process.exit(1);
}

// Find the target client + a campaign to attach replies to
let target = null;
let targetCampaign = null;
for (const c of clients) {
  const { data: camps } = await supabase
    .from("campaigns")
    .select("id, instantly_campaign_id, name")
    .eq("client_id", c.id)
    .limit(1);
  if (camps && camps.length > 0) {
    target = c;
    targetCampaign = camps[0];
    break;
  }
}

if (!target) {
  console.error("No client has a campaign to attach seeded replies to.");
  process.exit(1);
}

console.log(`Target client: ${target.name} (${target.id})`);
console.log(`Target campaign: ${targetCampaign.name} (${targetCampaign.id})`);

// Skip if we've already seeded (idempotent-ish)
const { count } = await supabase
  .from("lead_replies")
  .select("id", { count: "exact", head: true })
  .eq("client_id", target.id)
  .like("lead_email", "%@example-inbound-test.com");

if (count && count > 0) {
  console.log(`Already ${count} seed replies on this client. Skipping.`);
  console.log(`Delete first if you want fresh data:`);
  console.log(`  DELETE FROM lead_replies WHERE client_id = '${target.id}' AND lead_email LIKE '%@example-inbound-test.com';`);
  process.exit(0);
}

// Seed fixtures — spans the taxonomy so the UI exercises every badge
const now = Date.now();
const minutes = (n) => new Date(now - n * 60 * 1000).toISOString();

const rows = [
  {
    final_class: "true_interest",
    claude_class: "true_interest",
    instantly_category: "lead_interested",
    claude_confidence: 0.94,
    claude_reason: "Direct buying intent: explicitly asks about pricing and available time slots.",
    lead_name: "Sarah Chen",
    lead_email: "sarah.chen@example-inbound-test.com",
    lead_company: "Vantage Analytics",
    lead_title: "VP of Revenue Operations",
    lead_phone_e164: "+14155550131",
    subject: "Re: Quick question about your outbound",
    body_text:
      "Hi Mike,\n\nThis caught my eye — we've been trying to figure out a better way to run outbound at scale. What's the pricing like, and do you have time this week for a quick 15-min call? My afternoons Tue–Thu are usually open.\n\nThanks,\nSarah",
    received_at: minutes(4),
  },
  {
    final_class: "meeting_booked",
    claude_class: "meeting_booked",
    instantly_category: "lead_meeting_booked",
    claude_confidence: 0.99,
    claude_reason: "Calendly confirmation received; prospect booked Thursday 2pm PT.",
    lead_name: "Daniel Ortiz",
    lead_email: "d.ortiz@example-inbound-test.com",
    lead_company: "Keystone Logistics",
    lead_title: "Director of Sales",
    lead_phone_e164: "+12135550188",
    subject: "Meeting scheduled: Thursday 2:00pm PT",
    body_text:
      "I've booked a call for Thursday at 2pm PT. Looking forward to chatting.",
    received_at: minutes(12),
  },
  {
    final_class: "referral_forward",
    claude_class: "referral_forward",
    instantly_category: "lead_interested",
    claude_confidence: 0.88,
    claude_reason: "Prospect is not the decision-maker but is forwarding to their VP of Sales with email provided.",
    referral_contact: {
      email: "priya.sharma@example-inbound-test.com",
      name: "Priya Sharma",
      title: "VP of Sales",
    },
    keyword_flags: ["referral_email_present", "not_decision_maker_phrase"],
    lead_name: "Jordan Park",
    lead_email: "jordan.park@example-inbound-test.com",
    lead_company: "Meridian Systems",
    lead_title: "Marketing Manager",
    lead_phone_e164: "+16175550142",
    subject: "Re: worth a look?",
    body_text:
      "Hey — I'm not the right person for this, but I'm going to loop in Priya Sharma (priya.sharma@example-inbound-test.com), our VP of Sales. She handles outbound tooling evaluations. Good luck!",
    received_at: minutes(27),
  },
  {
    final_class: "qualifying_question",
    claude_class: "qualifying_question",
    instantly_category: "lead_interested",
    claude_confidence: 0.82,
    claude_reason: "Asks about specific technical capability before committing; buying-signal-adjacent.",
    lead_name: "Alex Winters",
    lead_email: "alex@example-inbound-test.com",
    lead_company: "Ridgeline Capital",
    lead_title: "Partner",
    lead_phone_e164: "+12125550177",
    subject: "Re: how we help hedge funds",
    body_text:
      "Interesting — a few questions before I'd take a meeting. How do you handle compliance review of outbound messaging? We're regulated and can't just let anyone send emails on our behalf. Also — can you share a rough sense of pricing per seat?",
    received_at: minutes(46),
  },
  {
    final_class: "objection_price",
    claude_class: "objection_price",
    instantly_category: "lead_neutral",
    claude_confidence: 0.77,
    claude_reason: "Price concern but not a hard no — worth a conversation.",
    lead_name: "Morgan Reed",
    lead_email: "morgan.reed@example-inbound-test.com",
    lead_company: "BrightPath Consulting",
    lead_title: "Founder",
    lead_phone_e164: "+13035550199",
    subject: "Re: scaling outbound for BrightPath",
    body_text:
      "Thanks for reaching out. Candidly — we looked at a couple of these last year and the price didn't pencil. If you're doing something materially different on cost, I'd listen. Otherwise probably not a fit right now.",
    received_at: minutes(74),
  },
  {
    final_class: "ooo",
    claude_class: "ooo",
    instantly_category: "lead_out_of_office",
    claude_confidence: 0.99,
    claude_reason: "Auto-reply: out of office through April 26.",
    lead_name: "Chris Hale",
    lead_email: "chris.hale@example-inbound-test.com",
    lead_company: "Northfield Labs",
    subject: "Out of office until April 26",
    body_text: "I'm out of office through April 26 with limited email access. I'll reply when I return. — Chris",
    received_at: minutes(120),
  },
  {
    final_class: "wrong_person_no_referral",
    claude_class: "wrong_person_no_referral",
    instantly_category: "lead_wrong_person",
    claude_confidence: 0.91,
    claude_reason: "Prospect says they're the wrong person but provides no forwarding contact.",
    keyword_flags: ["wrong_person_phrase"],
    lead_name: "Taylor Brooks",
    lead_email: "taylor@example-inbound-test.com",
    lead_company: "Summit Dynamics",
    subject: "Re: outbound at Summit",
    body_text: "Wrong person — I don't handle this. Please remove me.",
    received_at: minutes(200),
  },
];

let inserted = 0;
for (const row of rows) {
  const { error } = await supabase.from("lead_replies").insert({
    organization_id: target.organization_id,
    client_id: target.id,
    campaign_id: targetCampaign.id,
    instantly_campaign_id: targetCampaign.instantly_campaign_id,
    instantly_message_id: `seed-${row.lead_email}-${row.received_at}`,
    from_address: row.lead_email,
    to_address: "persona@alias-domain.test",
    lead_email: row.lead_email,
    lead_name: row.lead_name,
    lead_company: row.lead_company,
    lead_title: row.lead_title || null,
    lead_phone_e164: row.lead_phone_e164 || null,
    subject: row.subject,
    body_text: row.body_text,
    received_at: row.received_at,
    instantly_category: row.instantly_category,
    keyword_flags: row.keyword_flags || [],
    claude_class: row.claude_class,
    claude_confidence: row.claude_confidence,
    claude_reason: row.claude_reason,
    referral_contact: row.referral_contact || null,
    final_class: row.final_class,
    classified_at: row.received_at,
    status: "classified",
    notified_at: row.received_at,
  });
  if (error) {
    console.error(`Failed to insert ${row.lead_email}:`, error);
  } else {
    inserted++;
    console.log(`  ✓ ${row.final_class.padEnd(26)} ${row.lead_name}`);
  }
}

console.log(`\nSeeded ${inserted}/${rows.length} replies for ${target.name}.`);
console.log(`Open the client portal as this client to see the inbox render.`);
