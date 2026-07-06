// Spintax native-send dry-run (M2 verification).
//
// Renders a sample spintax step template IN MEMORY for 3 fixed fake contact
// UUIDs across body + step-0 subject + the "Re:" follow-up fallback, using the
// SAME seed-key scheme as run-native-sequences/route.ts:
//
//     body            ->  `${contact.id}:${stepIndex}:body`
//     step-0 subject  ->  `${contact.id}:0:subject`
//     Re: fallback    ->  `${contact.id}:0:subject`   (step index 0, on purpose)
//
// It proves three properties without touching the network:
//   (i)   determinism  — a second pass yields byte-identical output
//   (ii)  distribution — variety across the 3 contacts
//   (iii) Re:-coherence — the "Re:" subject re-uses the original step-0 render
//                         so the threaded subject is byte-identical
//
//   node scripts/test-spintax-send.mjs           # DRY — in-memory only, NO network
//   node scripts/test-spintax-send.mjs --send    # delivers ONE rendered email via Gmail
//
// The --send path mirrors scripts/test-send-david-email1.mjs (Gmail service
// account + domain-wide delegation). Default run makes ZERO network calls.
import { readFileSync } from "node:fs";
import { createSign, randomUUID } from "node:crypto";
import { renderSpintax } from "../src/lib/spintax/index.ts";

const SEND = process.argv.includes("--send");

// ---- Sample step (hardcoded spintax) ----
const SUBJECT_TPL = "{Quick|Fast} question about {{company}}";
const BODY_TPL =
  "{Hi|Hey|Hello} {{first_name}} — {quick|fast} question about {{company}}.\n\n" +
  "{We help|I help} teams like yours {win more meetings|book more calls}. {Worth a chat?|Open to a quick call?}";

// ---- Fixed fake contacts (stable UUIDs → deterministic renders) ----
const CONTACTS = [
  { id: "11111111-1111-1111-1111-111111111111", first_name: "Daniel", company_name: "Acme Roofing" },
  { id: "22222222-2222-2222-2222-222222222222", first_name: "Priya", company_name: "Northwind Labs" },
  { id: "33333333-3333-3333-3333-333333333333", first_name: "Marco", company_name: "Vertex Realty" },
];

// Token substitution, mirroring run-native-sequences renderTemplate (spintax
// already resolved by renderSpintax before this runs).
const normKey = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
function fillTokens(text, contact) {
  const std = {
    firstname: contact.first_name ?? "",
    company: contact.company_name ?? "",
    companyname: contact.company_name ?? "",
  };
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw) => {
    const k = normKey(raw);
    return k in std ? std[k] : whole;
  });
}

// Full render = spintax first (seeded), then token fill. Mirrors the route.
function renderStep(tpl, contact, spinKey) {
  return fillTokens(renderSpintax(tpl, spinKey), contact).trim();
}

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

console.log("=== Spintax native-send dry run (in-memory, NO network) ===\n");
console.log("Subject template:", JSON.stringify(SUBJECT_TPL));
console.log("Body template:   ", JSON.stringify(BODY_TPL));

const first = [];
for (const c of CONTACTS) {
  const subjKey = `${c.id}:0:subject`;
  const bodyKey0 = `${c.id}:0:body`;
  const reKey = `${c.id}:0:subject`; // Re: fallback re-uses step-0 subject key

  const subject = renderStep(SUBJECT_TPL, c, subjKey);
  const body = renderStep(BODY_TPL, c, bodyKey0);
  const reBase = renderStep(SUBJECT_TPL, c, reKey);
  const reSubject = reBase.toLowerCase().startsWith("re:") ? reBase : `Re: ${reBase}`;

  first.push({ subject, body, reSubject });

  console.log(`\n--- ${c.first_name} <${c.id}> ---`);
  console.log(`  Step-0 subject : ${subject}`);
  console.log(`  Re: subject    : ${reSubject}`);
  console.log(`  Body:\n${body.split("\n").map((l) => "    " + l).join("\n")}`);
}

console.log("\n=== Assertions ===");

// (i) Determinism — a second pass is byte-identical.
console.log("\n(i) Determinism (second pass identical):");
let detOk = true;
CONTACTS.forEach((c, i) => {
  const subject = renderStep(SUBJECT_TPL, c, `${c.id}:0:subject`);
  const body = renderStep(BODY_TPL, c, `${c.id}:0:body`);
  if (subject !== first[i].subject || body !== first[i].body) detOk = false;
});
ok(detOk, "all 3 contacts render byte-identical on the second pass");

// (ii) Distribution — variety across contacts (not all identical).
console.log("\n(ii) Distribution (variety across contacts):");
const subjects = first.map((f) => f.subject);
const bodies = first.map((f) => f.body);
ok(new Set(subjects).size > 1 || new Set(bodies).size > 1, "renders differ across the 3 contacts (spintax varies)");

// (iii) Re:-coherence — the Re: subject equals "Re: " + the original step-0 subject.
console.log("\n(iii) Re:-coherence (threaded subject byte-identical to original):");
let reOk = true;
first.forEach((f) => {
  const expected = f.subject.toLowerCase().startsWith("re:") ? f.subject : `Re: ${f.subject}`;
  if (f.reSubject !== expected) reOk = false;
});
ok(reOk, "Re: subject == 'Re: ' + the exact step-0 subject for the same contact");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);

if (!SEND) {
  console.log("\nDRY RUN — no network calls made. Pass --send to deliver one rendered email.");
  process.exit(fail === 0 ? 0 : 1);
}

// ================= SEND via Gmail (DWD) — mirrors test-send-david-email1.mjs =================
// Guarded: only reached with --send. Delivers ONE email (the first contact's
// step-0 render) so a human can eyeball the resolved copy in a real inbox.
const ENV = "C:/Users/danie/Documents/Claude/leadstart/.env.local";
const env = (() => { const r = readFileSync(ENV, "utf8"); const e = {}; for (const l of r.split(/\r?\n/)) { const m = l.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/); if (m) e[m[1]] = m[3]; } return e; })();
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const TO = "lemonade504@gmail.com";
const FROM_EMAIL = "molly@davidcabreraproperties.com";
const rest = async (p) => (await fetch(`${URL}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();

const mbs = await rest(`native_mailboxes?email_address=eq.${encodeURIComponent(FROM_EMAIL)}&select=email_address,display_name`);
const senderName = mbs[0]?.display_name ?? "Molly Anderson";
const c0 = CONTACTS[0];
const subject = renderStep(SUBJECT_TPL, c0, `${c0.id}:0:subject`);
const bodyText = renderStep(BODY_TPL, c0, `${c0.id}:0:body`);

console.log("\n=== Sending rendered spintax email ===");
console.log(`From:    ${senderName} <${FROM_EMAIL}>`);
console.log(`To:      ${TO}`);
console.log(`Subject: ${subject}`);
console.log("---\n" + bodyText + "\n---");

const org = (await rest(`organizations?select=gmail_service_account_email,gmail_service_account_key&limit=1`))[0];
const saEmail = org.gmail_service_account_email.trim();
const pk = org.gmail_service_account_key.replace(/\\n/g, "\n");
const b64url = (b) => (typeof b === "string" ? Buffer.from(b) : b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";
const iat = Math.floor(Date.now() / 1000);
const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = b64url(JSON.stringify({ iss: saEmail, sub: FROM_EMAIL, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
const signer = createSign("RSA-SHA256"); signer.update(`${head}.${claims}`); signer.end();
const assertion = `${head}.${claims}.${b64url(signer.sign(pk))}`;
const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) })).json();
if (!tok.access_token) { console.error("\n✗ Token request failed:", JSON.stringify(tok)); process.exit(1); }

function toFlowed(text, width = 72) {
  const out = [];
  for (const src of text.split(/\r?\n/)) {
    if (src.length === 0) { out.push(""); continue; }
    const line = /^(>| |From )/.test(src) ? " " + src : src;
    const words = line.split(" ");
    const chunks = []; let cur = "";
    for (const w of words) {
      if (cur === "") cur = w;
      else if ((cur + " " + w).length <= width) cur += " " + w;
      else { chunks.push(cur); cur = w; }
    }
    if (cur !== "") chunks.push(cur);
    chunks.forEach((ch, i) => out.push(i < chunks.length - 1 ? ch + " " : ch));
  }
  return out.join("\r\n");
}
function toHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = text.split(/\r?\n\r?\n/).map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\r?\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;">${paras}</div>`;
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
const boundary = "b_" + randomUUID().replace(/-/g, "");
const raw = [
  `From: ${senderName} <${FROM_EMAIL}>`, `To: ${TO}`, `Subject: ${subject}`,
  `Message-ID: <${randomUUID()}@davidcabreraproperties.com>`, `Date: ${new Date().toUTCString()}`,
  `MIME-Version: 1.0`, `Content-Type: multipart/alternative; boundary="${boundary}"`, ``,
  `--${boundary}`, `Content-Type: text/plain; charset="UTF-8"; format=flowed`, `Content-Transfer-Encoding: base64`, ``, b64(toFlowed(bodyText)),
  `--${boundary}`, `Content-Type: text/html; charset="UTF-8"`, `Content-Transfer-Encoding: base64`, ``, b64(toHtml(bodyText)),
  `--${boundary}--`,
].join("\r\n");
const send = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: b64url(raw) }) });
const sr = await send.json();
console.log(send.ok ? `\n✓ SENT — Gmail id ${sr.id}, thread ${sr.threadId}. Check ${TO}.` : `\n✗ SEND FAILED (${send.status}): ${JSON.stringify(sr)}`);
process.exit(send.ok ? 0 : 1);
