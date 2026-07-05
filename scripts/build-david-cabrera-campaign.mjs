/**
 * Build David Cabrera's native-email campaign end to end.
 *
 *   node scripts/build-david-cabrera-campaign.mjs                 # dry run (no writes)
 *   node scripts/build-david-cabrera-campaign.mjs --apply         # write to prod
 *   node scripts/build-david-cabrera-campaign.mjs --csv "<path>"  # override CSV path
 *
 * Dry run parses + cleans + dedupes the buyer-agent CSV, resolves the four
 * sending mailboxes, previews the rendered copy, and reports exactly what it
 * WOULD create — without touching the database. Pass --apply to actually:
 *   - insert the cleaned contacts under the David Cabrera client (custom_fields
 *     carrying PropertyAddress / SoldDate / Price),
 *   - create (or reuse) the native_email campaign as a DRAFT,
 *   - write its 6 steps + 4-mailbox rotation pool,
 *   - enroll every contact (status active, step 0).
 * Nothing sends: the campaign stays 'draft' until someone activates it.
 *
 * Idempotent: re-running reuses the campaign, refreshes its steps, and skips
 * contacts/enrollments that already exist (org-email + campaign/contact are
 * unique in the DB).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ---- Fixed identifiers (verified against prod on 2026-07-05) ----
const ORG_ID = "bfc96611-8b2f-49c2-b4e0-49ebadc295e1"; // LeadStart Agency
const CLIENT_ID = "9b15943d-ef85-4b5c-a9cb-01c911c542b8"; // David Cabrera
const CAMPAIGN_NAME = "David Cabrera — Buyer Agent Outreach";
const MAILBOX_EMAILS = [
  "molly@davidcabreraproperties.com",
  "jessica@davidcabreraproperties.com",
  "emily@getiniciopropertysolutions.com",
  "christy@getiniciopropertysolutions.com",
];

// Cadence: days after the previous step. ~19-day sequence.
const WAIT_DAYS = [0, 3, 3, 4, 4, 5];

// ---- The sequence. Subject null on step 1 (follow-up) => engine sends it as
// "Re: <step 0 subject>" in the same thread. Steps 2-5 carry their own
// subjects (the engine now honors them). {{tokens}} are resolved by the
// native sender against contact fields, custom_fields, and the sending inbox.
const STEPS = [
  {
    subject: "Congrats on closing {{PropertyAddress}}",
    body: `Hi {{FirstName}},

Congrats on closing {{PropertyAddress}} on {{SoldDate}}.

I know you probably get a lot of random emails, but I wanted to start by giving credit where it's due. Agents who are actively closing business are in a very different category from people who just hold a license. Actually getting buyers to the finish line takes hustle, follow-through, and trust.

That's part of why I thought it made sense to reach out.

I made the shift myself from being full-time in real estate to now working real estate part-time while also building out a second service that fits naturally alongside it.

What surprised me most was how well it complemented the relationships I already had and how many opportunities I had been overlooking before.

So when I see agents who are already producing, I naturally think: this person could probably do very well with this too.

If I can do it, I'd be glad to show you how I made the transition.

Would it be crazy if we could schedule a complimentary 60-minute conversation?

And if it makes sense to explore working together, we can discuss that. If not, you'll still leave with some valuable financial insights.

Best,
{{YourName}}`,
  },
  {
    subject: null, // -> "Re: Congrats on closing {{PropertyAddress}}"
    body: `Hi {{FirstName}},

Just wanted to follow up in case my last note got buried.

The main reason I reached out is simple: when I see agents who are actively closing, I know they already have the hardest part figured out. Building trust, creating momentum, and staying in conversation with people who are making big life decisions.

That's exactly why adding a second service made so much sense for me when I was full-time in real estate.

It wasn't about starting over. It was about serving the same type of people in one more way and creating another stream alongside what I was already doing.

That shift is a lot more practical than most agents think.

If you want, I can schedule a meeting where I give a quick breakdown of what it looks like.

Best,
{{YourName}}`,
  },
  {
    subject: "A natural add-on for agents",
    body: `Hi {{FirstName}},

One thing I realized when I was fully focused on real estate was this:

The conversations we're already having as agents naturally open the door to other needs.

When someone buys a home, moves, starts a family, changes jobs, or takes on a new mortgage, there's usually a bigger financial conversation happening in the background whether they bring it up or not.

That's what made adding a second service to my tool belt feel so natural.

I didn't have to become a different person or build a completely different network. I was already around the right people. I just learned how to help in one more area.

Now I do both part-time, and if I'm being honest, I wish I had made that move sooner.

If you've ever thought about adding something complementary to real estate without taking away from it, I think you'd probably find this interesting.

Want me to send a short overview?

Best,
{{YourName}}`,
  },
  {
    subject: "Two simple ways this can work",
    body: `Hi {{FirstName}},

I figured I'd make this really simple.

When agents ask me more about this, it usually ends up going one of two directions:

1. Add a second service to your business directly.
For agents who want to expand what they offer and create another lane of income alongside real estate.

2. Keep real estate as the main focus and refer it out.
For agents who like the idea, but would rather keep it simple and just connect people when the need comes up.

Both can work well. It really just depends on how hands-on you want to be.

That's one of the reasons I like sharing this with productive agents. There isn't just one way to make it fit.

If you want, I can show you what both paths look like and you can decide if either one makes sense.

Best,
{{YourName}}`,
  },
  {
    subject: "This ended up complementing real estate really well",
    body: `Hi {{FirstName}},

I know you're busy, so I'll keep this short.

I reached out because I saw you were actively closing and thought you might be a strong fit for the same shift I made from full-time real estate into a model where I now work real estate part-time and offer a second service alongside it.

For some agents, that turns into a real additional business line.

For others, it simply becomes a referral lane.

Either way, I thought it was worth mentioning to someone already doing business at a high level.

If you want more info, I'm happy to send it.

If not, no worries at all. Just reply pass and I'll close the loop.

Best,
{{YourName}}`,
  },
  {
    subject: "I'll leave this with you, {{FirstName}}",
    body: `Hi {{FirstName}},

At the risk of sending one email too many, I wanted to leave you with this:

A lot of good agents spend years sitting on opportunities that are already right in front of them, simply because no one ever showed them how to turn what they're already doing into something bigger.

That was me too for a while.

Once I saw how naturally a second service could fit alongside real estate, the shift became obvious. Now I do both part-time, and I've been grateful I made the move.

That may or may not be something you want right now, but if it ever is, I'd be glad to show you what helped me make that transition.

Best,
{{YourName}}`,
  },
];

// ------------------------------------------------------------------ env + REST
function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}
const env = loadEnvLocal();
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

async function rest(method, path, { body, prefer } = {}) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ------------------------------------------------------------------ CSV parse
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^﻿/, "");
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++;
      } else { field += c; i++; }
    } else if (c === '"') { inQuotes = true; i++; }
    else if (c === ",") { row.push(field); field = ""; i++; }
    else if (c === "\n" || c === "\r") {
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      if (c === "\r" && s[i + 1] === "\n") i += 2; else i++;
    } else { field += c; i++; }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function formatSoldDate(raw) {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return raw.trim();
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return raw.trim();
  return `${MONTHS[month - 1]} ${day}`;
}

function cleanAddress(raw) {
  const full = raw.replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
  const street = full.split(",")[0].trim();
  return { full, street };
}

// Mirror of the server-side native renderTemplate (for preview only).
function normalizeVarKey(name) { return name.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function render(template, contact, mailboxName) {
  const standard = {
    firstname: contact.first_name ?? "",
    lastname: contact.last_name ?? "",
    fullname: [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    company: contact.company_name ?? "",
    companyname: contact.company_name ?? "",
    title: contact.title ?? "",
    yourname: mailboxName,
    sendername: mailboxName,
    myname: mailboxName,
  };
  const custom = {};
  for (const [k, v] of Object.entries(contact.custom_fields ?? {})) {
    if (v != null) custom[normalizeVarKey(k)] = String(v);
  }
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw) => {
    const key = normalizeVarKey(raw);
    if (key in standard) return standard[key];
    if (key in custom) return custom[key];
    return whole;
  }).trim();
}

// ------------------------------------------------------------------ main
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const csvArgIdx = args.indexOf("--csv");
const CSV_PATH = csvArgIdx >= 0 ? args[csvArgIdx + 1]
  : "C:\\Users\\danie\\Downloads\\Buyer Agent Information - Sheet2.csv";

console.log(`Mode: ${APPLY ? "APPLY (writing to prod)" : "DRY RUN (no writes)"}`);
console.log(`CSV:  ${CSV_PATH}\n`);

const grid = parseCSV(readFileSync(CSV_PATH, "utf8"));
const header = grid[0].map((h) => h.trim().toLowerCase());
// Column indexes by header (defensive against reordering).
const idx = {
  sold: header.findIndex((h) => h === "sold"),
  price: header.findIndex((h) => h.includes("price") || h === ""), // price col has blank header
  address: header.findIndex((h) => h === "address"),
  first: header.findIndex((h) => h.includes("first")),
  last: header.findIndex((h) => h.includes("last")),
  phone: header.findIndex((h) => h.includes("phone")),
  email: header.findIndex((h) => h.includes("email")),
  office: header.findIndex((h) => h.includes("office")),
};
// The price column has an empty header ("") between Sold and Address.
if (idx.price === idx.sold) idx.price = 1;
console.log("Column map:", idx, "\n");

const skips = { no_email: 0, bad_email: 0, no_first: 0, no_address: 0, no_date: 0, dup_in_csv: 0 };
const seen = new Set();
const parsed = [];
for (let r = 1; r < grid.length; r++) {
  const row = grid[r];
  const g = (i) => (i >= 0 ? (row[i] ?? "").trim() : "");
  const email = g(idx.email).toLowerCase();
  const first = g(idx.first);
  const addrRaw = g(idx.address);
  const soldRaw = g(idx.sold);

  if (!email) { skips.no_email++; continue; }
  if (!email.includes("@") || /\s/.test(email)) { skips.bad_email++; continue; }
  if (!first || first.toLowerCase() === "nonmls") { skips.no_first++; continue; }
  if (!addrRaw) { skips.no_address++; continue; }
  if (!soldRaw) { skips.no_date++; continue; }
  if (seen.has(email)) { skips.dup_in_csv++; continue; }
  seen.add(email);

  const { full, street } = cleanAddress(addrRaw);
  parsed.push({
    email,
    first_name: first,
    last_name: g(idx.last) || null,
    phone: g(idx.phone) || null,
    company_name: g(idx.office) || null,
    custom_fields: {
      PropertyAddress: street,
      PropertyAddressFull: full,
      SoldDate: formatSoldDate(soldRaw),
      Price: g(idx.price) || "",
    },
  });
}

console.log(`Parsed ${parsed.length} unique, valid contacts from ${grid.length - 1} data rows.`);
console.log("Skipped:", skips, "\n");

// Resolve mailboxes.
const mailboxes = await rest("GET", `native_mailboxes?organization_id=eq.${ORG_ID}&select=id,email_address,display_name,status&email_address=in.(${MAILBOX_EMAILS.map((e) => `"${e}"`).join(",")})`);
console.log(`Mailboxes resolved (${mailboxes.length}/${MAILBOX_EMAILS.length}):`);
for (const m of mailboxes) console.log(`  ${m.email_address}  "${m.display_name}"  [${m.status}]`);
const missingMb = MAILBOX_EMAILS.filter((e) => !mailboxes.some((m) => m.email_address === e));
if (missingMb.length) console.log("  MISSING:", missingMb);
console.log();

// Existing contacts in this org for these emails (org-email is unique).
const emails = parsed.map((p) => p.email);
const existing = [];
for (const c of chunk(emails, 150)) {
  const inList = c.map((e) => `"${e}"`).join(",");
  const rows = await rest("GET", `contacts?organization_id=eq.${ORG_ID}&select=id,email,client_id&email=in.(${inList})`);
  existing.push(...rows);
}
const existingByEmail = new Map(existing.map((c) => [c.email.toLowerCase(), c]));
const reuseMine = [];   // existing contacts already under David -> reuse + refresh custom_fields
const conflictOther = []; // existing under a different client -> skip (don't poach)
const toInsert = [];
for (const p of parsed) {
  const ex = existingByEmail.get(p.email);
  if (!ex) { toInsert.push(p); continue; }
  if (ex.client_id === CLIENT_ID) reuseMine.push({ ...p, id: ex.id });
  else conflictOther.push({ ...p, existing_client: ex.client_id });
}

console.log(`Contact plan:`);
console.log(`  new inserts:            ${toInsert.length}`);
console.log(`  reused (already David): ${reuseMine.length}`);
console.log(`  skipped (other client): ${conflictOther.length}`);
const enrollTargetCount = toInsert.length + reuseMine.length;
console.log(`  -> enrollable contacts: ${enrollTargetCount}\n`);

// Preview render for a sample contact.
const sample = parsed[0];
const sampleMailbox = mailboxes[0]?.display_name ?? "Molly Anderson";
console.log(`── Preview (contact: ${sample.first_name}, inbox: "${sampleMailbox}") ─────────────`);
console.log(`Step 1 subject: ${render(STEPS[0].subject, sample, sampleMailbox)}`);
console.log(`Step 6 subject: ${render(STEPS[5].subject, sample, sampleMailbox)}`);
console.log(`\nStep 1 body:\n${render(STEPS[0].body, sample, sampleMailbox)}`);
console.log(`─────────────────────────────────────────────────────────────\n`);

if (!APPLY) {
  console.log("DRY RUN complete. No database changes made. Re-run with --apply to write.");
  process.exit(0);
}

// ============================ APPLY ============================
if (mailboxes.length === 0) { console.error("Refusing to apply: no mailboxes resolved."); process.exit(1); }

// 1) Insert new contacts (chunked). Client-generated UUIDs so we know the ids.
const now = new Date().toISOString();
const insertRows = toInsert.map((p) => ({
  id: randomUUID(),
  organization_id: ORG_ID,
  client_id: CLIENT_ID,
  campaign_id: null,
  first_name: p.first_name,
  last_name: p.last_name,
  email: p.email,
  company_name: p.company_name,
  phone: p.phone,
  custom_fields: p.custom_fields,
  status: "new",
  source: "csv-import-david-cabrera",
  created_at: now,
  updated_at: now,
}));
let inserted = 0;
for (const c of chunk(insertRows, 200)) {
  await rest("POST", "contacts", { body: c, prefer: "return=minimal" });
  inserted += c.length;
  console.log(`  inserted ${inserted}/${insertRows.length} contacts`);
}

// 1b) Refresh custom_fields on reused David contacts so their merge vars render.
for (const p of reuseMine) {
  await rest("PATCH", `contacts?id=eq.${p.id}`, {
    body: { custom_fields: p.custom_fields, updated_at: now },
    prefer: "return=minimal",
  });
}
if (reuseMine.length) console.log(`  refreshed custom_fields on ${reuseMine.length} reused contacts`);

const contactIds = [...insertRows.map((r) => r.id), ...reuseMine.map((r) => r.id)];

// 2) Create or reuse the campaign (draft).
let campaignId;
const existingCampaign = await rest(
  "GET",
  `campaigns?organization_id=eq.${ORG_ID}&client_id=eq.${CLIENT_ID}&source_channel=eq.native_email&name=eq.${encodeURIComponent(CAMPAIGN_NAME)}&select=id,status`,
);
if (existingCampaign.length) {
  campaignId = existingCampaign[0].id;
  console.log(`  reusing existing campaign ${campaignId} (status ${existingCampaign[0].status})`);
} else {
  campaignId = randomUUID();
  await rest("POST", "campaigns", {
    body: [{
      id: campaignId,
      organization_id: ORG_ID,
      client_id: CLIENT_ID,
      name: CAMPAIGN_NAME,
      status: "draft",
      source_channel: "native_email",
    }],
    prefer: "return=minimal",
  });
  console.log(`  created campaign ${campaignId} (draft)`);
}

// 3) Steps — replace any existing set with a fresh 6.
await rest("DELETE", `campaign_steps?campaign_id=eq.${campaignId}`, { prefer: "return=minimal" });
const stepRows = STEPS.map((s, i) => ({
  campaign_id: campaignId,
  step_index: i,
  kind: "email",
  wait_days: WAIT_DAYS[i],
  subject_template: s.subject,
  body_template: s.body,
}));
await rest("POST", "campaign_steps", { body: stepRows, prefer: "return=minimal" });
console.log(`  wrote ${stepRows.length} steps`);

// 4) Mailbox rotation pool (ignore dupes).
const poolRows = mailboxes.map((m) => ({ campaign_id: campaignId, mailbox_id: m.id }));
await rest("POST", "campaign_mailboxes?on_conflict=campaign_id,mailbox_id", {
  body: poolRows,
  prefer: "return=minimal,resolution=ignore-duplicates",
});
console.log(`  wrote ${poolRows.length} mailbox-pool rows`);

// 5) Enroll every target contact (ignore dupes on campaign_id,contact_id).
const enrollRows = contactIds.map((cid) => ({
  campaign_id: campaignId,
  contact_id: cid,
  current_step_index: 0,
  status: "active",
}));
let enrolled = 0;
for (const c of chunk(enrollRows, 200)) {
  await rest("POST", "campaign_enrollments?on_conflict=campaign_id,contact_id", {
    body: c,
    prefer: "return=minimal,resolution=ignore-duplicates",
  });
  enrolled += c.length;
  console.log(`  enrolled ${enrolled}/${enrollRows.length}`);
}

console.log(`\nDONE. Campaign ${campaignId} is a DRAFT with ${contactIds.length} contacts enrolled.`);
console.log("Nothing will send until it is activated.");
