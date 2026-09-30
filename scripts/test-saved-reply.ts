#!/usr/bin/env node
/**
 * Unit tests for src/lib/replies/saved-reply.ts: a campaign's saved reply for
 * hot leads, filled in for one lead (migration 00134).
 *
 * Covers:
 *   1. Contact fields ({{first_name}}, custom {{firm}}, {{report_link}}) and the
 *      sending inbox's {{signature}} / {{your_name}} fill in.
 *   2. A token with no value (absent OR blank) stays visible as {{token}} and is
 *      listed in `missing`, so the reply box can refuse to send it.
 *   3. `signed` tells whether the saved reply signs itself.
 *   4. cleanReplyTemplate: CRLF, control characters, blank → null, the size cap.
 *
 * No network, no DB. Usage: npx tsx scripts/test-saved-reply.ts
 */

import { renderSavedReply, cleanReplyTemplate, MAX_REPLY_TEMPLATE_CHARS } from "../src/lib/replies/saved-reply.ts";
import type { TokenContact } from "../src/lib/native/tokens.ts";

let failed = 0;
let passed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
}

const lead: TokenContact = {
  first_name: "Maya",
  last_name: "Hartwell",
  company_name: "Hartwell Law Firm",
  title: null,
  intro_line: null,
  email: "maya@hartwelllaw.example",
  phone: null,
  custom_fields: {
    firm: "Hartwell Law Firm",
    report_link: "https://tube-seo.vercel.app/api/prospect-report?id=00000000-0000-4000-8000-000000000001",
    ai_visibility: "0",
  },
};
const inbox = {
  display_name: "Sam Rivera",
  email_address: "sam@sender.example",
  signature: "{{your_name}}\nCo-Founder\nTuBe SEO",
};

// 1. Everything fills.
{
  const r = renderSavedReply(
    "Hi {{first_name}},\r\n\r\nHere's the report for {{firm}}: {{report_link}}\r\n\r\n{{signature}}",
    lead,
    inbox,
  );
  check("fills first_name", r.body.startsWith("Hi Maya,"), r.body);
  check("fills custom firm", r.body.includes("report for Hartwell Law Firm:"), r.body);
  check("fills report_link", r.body.includes("prospect-report?id=00000000-0000-4000-8000-000000000001"), r.body);
  check("fills signature with the inbox's name", r.body.endsWith("Sam Rivera\nCo-Founder\nTuBe SEO"), r.body);
  check("no CRLF left", !r.body.includes("\r"), r.body);
  check("nothing missing", r.missing.length === 0, r.missing);
  check("signed", r.signed === true);
}

// 2a. A lead with no report link: the token stays visible and is listed.
{
  const noLink = { ...lead, custom_fields: { firm: "Hartwell Law Firm" } };
  const r = renderSavedReply("Hi {{first_name}}, here it is: {{report_link}}", noLink, inbox);
  check("absent value stays visible", r.body.includes("{{report_link}}"), r.body);
  check("absent value listed", r.missing.join() === "report_link", r.missing);
}

// 2b. A blank value is treated the same (never prints as nothing).
{
  const blank = { ...lead, custom_fields: { ...lead.custom_fields, report_link: "   " } };
  const r = renderSavedReply("Link: {{report_link}}", blank, inbox);
  check("blank value stays visible", r.body === "Link: {{report_link}}", r.body);
  check("blank value listed", r.missing.join() === "report_link", r.missing);
}

// 2c. A typo'd token is missing too.
{
  const r = renderSavedReply("See {{reprot_link}}", lead, inbox);
  check("typo stays visible", r.body === "See {{reprot_link}}", r.body);
  check("typo listed", r.missing.join() === "reprot_link", r.missing);
}

// 2d. An inline default fills and is not missing.
{
  const r = renderSavedReply("Hi {{nickname|there}}", lead, inbox);
  check("inline default used", r.body === "Hi there", r.body);
  check("inline default not missing", r.missing.length === 0, r.missing);
}

// 3. Unsigned saved reply; no inbox; no contact.
{
  const r = renderSavedReply("Hi {{first_name}}", lead, inbox);
  check("unsigned", r.signed === false);
  const r2 = renderSavedReply("Thanks, {{your_name}}", lead, null);
  check("your_name counts as signed", r2.signed === true);
  const r3 = renderSavedReply("Hi {{first_name}}", null, inbox);
  check("no contact → first_name missing", r3.missing.join() === "first_name" && r3.body === "Hi {{first_name}}", r3);
}

// 4. cleanReplyTemplate.
{
  check("blank → null", cleanReplyTemplate("  \n ") === null);
  check("non-string → null", cleanReplyTemplate(42) === null);
  check("CRLF → LF, trimmed", cleanReplyTemplate("  a\r\nb\rc  ") === "a\nb\nc");
  check("control chars out, tabs kept", cleanReplyTemplate("a\u0000b\u0007c\td") === "abc\td");
  let threw = false;
  try {
    cleanReplyTemplate("x".repeat(MAX_REPLY_TEMPLATE_CHARS + 1));
  } catch {
    threw = true;
  }
  check("over the cap throws", threw);
  check("at the cap is fine", cleanReplyTemplate("x".repeat(MAX_REPLY_TEMPLATE_CHARS))?.length === MAX_REPLY_TEMPLATE_CHARS);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
