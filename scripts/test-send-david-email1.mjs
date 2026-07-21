// (1) Verifies the variable mapping across all David-campaign contacts, then
// (2) sends a live test of Email 1 to lemonade504@gmail.com from Molly's inbox,
// rendered exactly as the dispatcher would (FirstName=Daniel, SoldDate=May 29,
// a real PropertyAddress, YourName=the sending inbox's display name).
//
//   node scripts/test-send-david-email1.mjs           # verify + DRY (no send)
//   node scripts/test-send-david-email1.mjs --send    # verify + actually send
import { readFileSync } from "node:fs";
import { createSign, randomUUID } from "node:crypto";

const ENV = "C:/Users/danie/Documents/Claude/leadstart/.env.local";
const env = (() => { const r = readFileSync(ENV, "utf8"); const e = {}; for (const l of r.split(/\r?\n/)) { const m = l.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/); if (m) e[m[1]] = m[3]; } return e; })();
const URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const CAMPAIGN = "f9c179e6-799d-44f4-8753-806fcc1c2b83";
const SEND = process.argv.includes("--send");
const TO = "lemonade504@gmail.com";
const FROM_EMAIL = "molly@davidcabreraproperties.com";

const rest = async (p) => (await fetch(`${URL}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();

// ---- render (mirror of run-native-sequences renderTemplate) ----
const norm = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
function render(tpl, contact, senderName) {
  const std = { firstname: contact.first_name ?? "", lastname: contact.last_name ?? "", fullname: [contact.first_name, contact.last_name].filter(Boolean).join(" "), company: contact.company_name ?? "", companyname: contact.company_name ?? "", title: contact.title ?? "", introline: contact.intro_line ?? "", intro: contact.intro_line ?? "", email: contact.email ?? "", phone: contact.phone ?? "", yourname: senderName, sendername: senderName, myname: senderName };
  const cf = {}; for (const [k, v] of Object.entries(contact.custom_fields ?? {})) if (v != null) cf[norm(k)] = String(v);
  return tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw) => { const k = norm(raw); return k in std ? std[k] : k in cf ? cf[k] : whole; }).trim();
}
const RESOLVABLE = new Set(["firstname", "lastname", "fullname", "company", "companyname", "title", "introline", "intro", "email", "phone", "yourname", "sendername", "myname", "propertyaddress", "propertyaddressfull", "solddate", "price"]);

// ================= VERIFY =================
console.log("=== Variable-mapping verification ===");
const steps = await rest(`campaign_steps?campaign_id=eq.${CAMPAIGN}&select=step_index,subject_template,body_template&order=step_index`);
const tokenSet = new Set();
for (const s of steps) for (const t of `${s.subject_template ?? ""} ${s.body_template ?? ""}`.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) tokenSet.add(t[1].trim());
console.log("Tokens used in the sequence:", [...tokenSet].join(", "));
const unresolved = [...tokenSet].filter((t) => !RESOLVABLE.has(norm(t)));
console.log(unresolved.length ? `⚠ UNRESOLVABLE tokens: ${unresolved.join(", ")}` : "✓ every token maps to a real field (FirstName, PropertyAddress, SoldDate → contact; YourName → sending inbox)");

const contacts = await rest(`contacts?source=eq.csv-import-david-cabrera&select=first_name,custom_fields&limit=2000`);
let missFirst = 0, missAddr = 0, missSold = 0;
for (const c of contacts) {
  if (!(c.first_name ?? "").trim()) missFirst++;
  if (!(c.custom_fields?.PropertyAddress ?? "").trim()) missAddr++;
  if (!(c.custom_fields?.SoldDate ?? "").trim()) missSold++;
}
console.log(`\nContacts checked: ${contacts.length}`);
console.log(`  missing FirstName:      ${missFirst}`);
console.log(`  missing PropertyAddress:${missAddr}`);
console.log(`  missing SoldDate:       ${missSold}`);
console.log(missFirst + missAddr + missSold === 0 ? "✓ every contact has all three merge fields → nothing will render blank" : "⚠ some contacts would render a blank variable");

const mbs = await rest(`native_mailboxes?email_address=in.("molly@davidcabreraproperties.com","jessica@davidcabreraproperties.com","emily@getiniciopropertysolutions.com","christy@getiniciopropertysolutions.com")&select=email_address,display_name`);
console.log("\nSending inboxes (YourName source):");
for (const m of mbs) console.log(`  ${m.email_address} → "${m.display_name}"${m.display_name ? "" : "  ⚠ NO DISPLAY NAME"}`);

// ================= RENDER TEST EMAIL =================
const senderName = mbs.find((m) => m.email_address === FROM_EMAIL)?.display_name ?? "Molly Anderson";
const testContact = { first_name: "Daniel", custom_fields: { PropertyAddress: "11218 Cliffwood Drive", SoldDate: "May 29" } };
const step0 = steps.find((s) => s.step_index === 0);
const subject = render(step0.subject_template, testContact, senderName);
const bodyText = render(step0.body_template, testContact, senderName);
const leftover = `${subject}\n${bodyText}`.match(/\{\{[^}]+\}\}/g);
console.log("\n=== Rendered test email (Email 1) ===");
console.log(`From:    ${senderName} <${FROM_EMAIL}>`);
console.log(`To:      ${TO}`);
console.log(`Subject: ${subject}`);
console.log(`Unresolved placeholders left: ${leftover ? leftover.join(", ") : "none ✓"}`);
console.log("---\n" + bodyText + "\n---");

if (!SEND) { console.log("\nDRY RUN — pass --send to actually deliver it."); process.exit(0); }

// ================= SEND via Gmail (DWD) =================
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
if (!tok.access_token) { console.error("\n✗ Token request failed (DWD not authorized for gmail.send?):", JSON.stringify(tok)); process.exit(1); }

// format=flowed (RFC 3676): wrap long paragraphs into <=72-char lines, each
// continued line ending in a trailing SPACE so clients reflow to any width.
function toFlowed(text, width = 72) {
  const out = [];
  for (const src of text.split(/\r?\n/)) {
    if (src.length === 0) { out.push(""); continue; }
    const line = /^(>| |From )/.test(src) ? " " + src : src; // space-stuffing
    const words = line.split(" ");
    const chunks = []; let cur = "";
    for (const w of words) {
      if (cur === "") cur = w;
      else if ((cur + " " + w).length <= width) cur += " " + w;
      else { chunks.push(cur); cur = w; }
    }
    if (cur !== "") chunks.push(cur);
    chunks.forEach((c, i) => out.push(i < chunks.length - 1 ? c + " " : c));
  }
  return out.join("\r\n");
}
// Lightweight HTML: escape, then paragraphs (blank line) → spacing, single
// newlines → <br>. No images, no tracking, no links — just reflowable text.
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
