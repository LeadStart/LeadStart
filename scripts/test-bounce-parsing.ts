#!/usr/bin/env node
/**
 * Unit tests for bounce-notice parsing in src/lib/gmail/mime.ts:
 * parseGmailMessage (DSN fields + original Message-IDs), isBounce,
 * classifyBounce, extractFailedRecipient. No network, no DB.
 *
 * WHY THE FIXTURES LOOK THE WAY THEY DO: every payload below mirrors the part
 * tree the Gmail API ACTUALLY returned for a real notice in our sending
 * mailboxes (read 2026-09-25; addresses and ids replaced). The earlier parser
 * was written against an assumed shape (a message/delivery-status part with a
 * body of its own) that Gmail never produces, so it read nothing from any real
 * notice and nothing caught it. Keep these shapes honest: if a new notice type
 * shows up, copy its real part tree here before changing the parser.
 *
 * Anchors:
 *   - Gmail "(Failure)" 5.1.1          → hard / invalid_address / exact Message-ID
 *   - Gmail "(Delay)" 4.4.4            → soft
 *   - Gmail "(Failure)" after retries  → HARD / unreachable (Action: failed, 4.4.4)
 *   - same, fields unreadable          → HARD via the "(Failure)" subject
 *   - Exchange NDR, Gmail spam block   → hard / spam_block (5.7.350), Original-Recipient wins
 *   - Mimecast / M365 NDR              → hard / invalid_address, 5.4.1 (not 5.0.0), rfc/822 address
 *   - Gmail 5.7.26 (mentions "spam")   → auth_failure, not spam_block
 *   - Action: relayed                  → none
 *   - References ranking               → direct parent first
 *
 * Usage:
 *   npx tsx scripts/test-bounce-parsing.ts
 */

import {
  parseGmailMessage,
  isBounce,
  classifyBounce,
  extractFailedRecipient,
} from "../src/lib/gmail/mime.ts";
import type { GmailMessage, GmailPayloadPart } from "../src/lib/gmail/client.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// ---------- fixture helpers (shapes copied from real Gmail API output) ----------

const b64 = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const h = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
const text = (body: string, headers: Record<string, string> = {}): GmailPayloadPart => ({
  mimeType: "text/plain",
  filename: "",
  headers: h({ "Content-Type": "text/plain; charset=UTF-8", ...headers }),
  body: { size: body.length, data: b64(body) },
});
// Gmail never gives message/delivery-status a body: the fields ride on its
// child part, split between the child's HEADERS and the child's body text.
const deliveryStatus = (childHeaders: Record<string, string>, childBody: string | null): GmailPayloadPart => ({
  mimeType: "message/delivery-status",
  filename: "",
  headers: h({ "Content-Type": "message/delivery-status" }),
  body: { size: 0 },
  parts: [
    {
      mimeType: "text/plain",
      filename: "",
      headers: h(childHeaders),
      body: childBody == null ? { size: 0 } : { size: childBody.length, data: b64(childBody) },
    },
  ],
});
const msg = (headers: Record<string, string>, parts: GmailPayloadPart[]): GmailMessage => ({
  id: "m1",
  threadId: "t1",
  internalDate: String(Date.parse("2026-09-13T18:00:00Z")),
  payload: { mimeType: "multipart/report", filename: "", headers: h(headers), body: { size: 0 }, parts },
});
const gmailHuman = (s: string): GmailPayloadPart => ({
  mimeType: "multipart/related",
  filename: "",
  headers: [],
  body: { size: 0 },
  parts: [
    { mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: [text(s)] },
    { mimeType: "image/png", filename: "icon.png", headers: [], body: { size: 1234, attachmentId: "att1" } as never },
  ],
});
const GMAIL_DSN_HEADERS = (subject: string, orig: string, extra: Record<string, string> = {}) => ({
  From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
  Subject: subject,
  "Content-Type": 'multipart/report; boundary="b"; report-type=delivery-status',
  "Auto-Submitted": "auto-replied",
  "In-Reply-To": orig,
  References: orig,
  ...extra,
});

// ---------- 1. Gmail "(Failure)" 5.1.1 ----------
console.log('\n■ Gmail "(Failure)" 5.1.1 → hard / invalid_address / exact Message-ID');
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Failure)", "<orig-1@mail.gmail.com>", { "X-Failed-Recipients": "gone@example.com" }), [
      gmailHuman("Address not found\nYour message wasn't delivered to gone@example.com because the address couldn't be found."),
      deliveryStatus(
        { "Reporting-MTA": "dns; googlemail.com", "Arrival-Date": "Thu, 13 Aug 2026 12:20:34 -0700 (PDT)", "X-Original-Message-ID": "<orig-1@mail.gmail.com>" },
        "Final-Recipient: rfc822; gone@example.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; The email account that you tried to reach does not exist. Please try\n double-checking the recipient's email address.\nLast-Attempt-Date: Thu, 13 Aug 2026 12:20:34 -0700 (PDT)",
      ),
      { mimeType: "text/rfc822-headers", filename: "", headers: [], body: { size: 1, data: b64("Message-ID: <orig-1@mail.gmail.com>\nIn-Reply-To: <previous-step@mail.gmail.com>\nSubject: Re: hello") } },
    ]),
  );
  const v = classifyBounce(p);
  assert(isBounce(p), "isBounce");
  assert(p.dsn.action === "failed" && p.dsn.status === "5.1.1", `DSN fields read from the child part (got ${p.dsn.action}/${p.dsn.status})`);
  assert(v.severity === "hard" && v.bounceClass === "invalid_address", `hard / invalid_address (got ${v.severity}/${v.bounceClass})`);
  assert(v.diagnostic?.includes("does not exist. Please try double-checking") === true, "diagnostic unfolded from a continuation line");
  assert(extractFailedRecipient(p) === "gone@example.com", "recipient from X-Failed-Recipients");
  assert(p.dsn.originalMessageIds[0] === "<orig-1@mail.gmail.com>", "original Message-ID ranked first");
  assert(!p.dsn.originalMessageIds.includes("<previous-step@mail.gmail.com>"), "the original's own In-Reply-To (previous step) is NOT a candidate");
}

// ---------- 2. Gmail "(Delay)" ----------
console.log('\n■ Gmail "(Delay)" 4.4.4 → soft');
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Delay)", "<orig-2@mail.gmail.com>"), [
      gmailHuman("Message not delivered yet. 451 4.4.4 Mail received as unauthenticated ..."),
      deliveryStatus(
        { "Reporting-MTA": "dns; googlemail.com", "X-Original-Message-ID": "<orig-2@mail.gmail.com>" },
        "Final-Recipient: rfc822; agent@realtor.example\nAction: delayed\nStatus: 4.4.4\nRemote-MTA: dns; realtor-example.mail.protection.outlook.com.\n (2a01:111:f403:f803::, the server for the domain realtor.example.)\nDiagnostic-Code: smtp; 451 4.4.4 Mail received as unauthenticated, incoming to a recipient domain configured in a hosted tenant which has no mail-enabled subscriptions. ATTR5\nWill-Retry-Until: Sun, 13 Sep 2026 11:00:53 -0700 (PDT)",
      ),
    ]),
  );
  const v = classifyBounce(p);
  assert(v.severity === "soft" && v.bounceClass === null, `soft, no class (got ${v.severity}/${v.bounceClass})`);
}

// ---------- 3. Gmail final "(Failure)" after retries: THE regression ----------
console.log('\n■ Gmail final "(Failure)" after retries (Action: failed, 4.4.4) → HARD / unreachable');
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Failure)", "<orig-3@mail.gmail.com>", { "X-Failed-Recipients": "agent@realtor.example" }), [
      gmailHuman("Message not delivered. There was a problem delivering your message to agent@realtor.example. 451 4.4.4 Mail received as unauthenticated ..."),
      deliveryStatus(
        { "Reporting-MTA": "dns; googlemail.com", "X-Original-Message-ID": "<orig-3@mail.gmail.com>" },
        "Final-Recipient: rfc822; agent@realtor.example\nAction: failed\nStatus: 4.4.4\nDiagnostic-Code: smtp; 451 4.4.4 Mail received as unauthenticated, incoming to a recipient domain configured in a hosted tenant which has no mail-enabled subscriptions. ATTR5",
      ),
    ]),
  );
  const v = classifyBounce(p);
  assert(v.severity === "hard", `hard: the retries are exhausted even though the last code was 4.x.x (got ${v.severity})`);
  assert(v.code === "4.4.4" && v.bounceClass === "unreachable", `unreachable / 4.4.4 (got ${v.bounceClass}/${v.code})`);
}

// ---------- 4. same final notice, DSN fields missing ----------
console.log('\n■ final "(Failure)" with no readable DSN fields → still HARD via the subject');
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Failure)", "<orig-4@mail.gmail.com>"), [
      gmailHuman("Message not delivered. The recipient server did not accept our requests to connect. [realtor.example 4.4.1: timed out]"),
    ]),
  );
  const v = classifyBounce(p);
  assert(v.severity === "hard" && v.bounceClass === "unreachable", `hard / unreachable (got ${v.severity}/${v.bounceClass})`);
}

// ---------- 5. Exchange NDR: forwarded copy refused by Gmail as spam ----------
console.log("\n■ Exchange NDR, Gmail refused the forwarded copy (5.7.350) → hard / spam_block");
{
  const p = parseGmailMessage(
    msg(
      {
        From: "Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@tenant.onmicrosoft.com>",
        Subject: "Undeliverable: Re: Congrats on closing 123 Main St",
        "Content-Type": 'multipart/report; report-type=delivery-status; boundary="b"',
        "X-MS-Exchange-Message-Is-Ndr": "",
        "In-Reply-To": "<orig-5@mail.gmail.com>",
        References: "<orig-0@mail.gmail.com> <orig-5@mail.gmail.com>",
        "Auto-Submitted": "auto-replied",
      },
      [
        { mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: [text("Your message to agent@brokerage.example couldn't be delivered.\nYour quoted email: we help agents build their reputation...")] },
        deliveryStatus(
          { "Reporting-MTA": "dns;SA3PR18MB3539.namprd18.prod.outlook.com", "Arrival-Date": "Fri, 4 Sep 2026 15:00:54 +0000" },
          "Original-Recipient: rfc822;agent@brokerage.example\nFinal-Recipient: rfc822;agent.personal@gmail.com\nAction: failed\nStatus: 5.7.350\nDiagnostic-Code: smtp;550 5.7.350 Remote server returned message detected as spam -> 550 5.7.1 [2a01:111:f403:c107::3 19] Gmail has detected that this message is likely suspicious due to the very low reputation of the sending domain. To best protect our users from spam, the message has been blocked.\nRemote-MTA: dns;mx.google.com",
        ),
        {
          mimeType: "message/rfc822",
          filename: "",
          headers: h({ "Content-Type": "message/rfc822" }),
          body: { size: 0 },
          parts: [{ mimeType: "multipart/alternative", filename: "", headers: h({ "Message-ID": "<orig-5@mail.gmail.com>", Subject: "Re: Congrats" }), body: { size: 0 }, parts: [] }],
        },
      ],
    ),
  );
  const v = classifyBounce(p);
  assert(isBounce(p), "isBounce (Exchange NDR header)");
  assert(v.severity === "hard" && v.code === "5.7.350" && v.bounceClass === "spam_block", `hard / 5.7.350 / spam_block (got ${v.severity}/${v.code}/${v.bounceClass})`);
  assert(v.diagnostic?.includes("very low reputation of the sending domain") === true, "diagnostic keeps Gmail's reputation wording");
  assert(extractFailedRecipient(p) === "agent@brokerage.example", "Original-Recipient (what WE sent to) beats the forward target");
  assert(p.dsn.originalMessageIds[0] === "<orig-5@mail.gmail.com>", "Message-ID from the attached original");
}

// ---------- 6. Mimecast / Microsoft 365 NDR (the ones that were dropped) ----------
console.log("\n■ Mimecast / M365 NDR (all fields as child headers, rfc/822) → hard / invalid_address");
{
  const p = parseGmailMessage(
    msg(
      {
        From: "postmaster@realty.example",
        Subject: "Your message couldn't be delivered",
        "Content-Type": 'multipart/report; report-type=delivery-status; boundary="b"',
      },
      [
        { mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: [text("Your message couldn't be delivered\n5.4.1 Recipient address rejected: Access denied.")] },
        deliveryStatus(
          {
            "Original-Envelope-Id": "DoETQPMoNoeF7oNa4OuPug",
            "Reporting-MTA": "dns;usb-smtp-inbound-delivery-1.mimecast.com",
            Action: "failed",
            Status: "5.0.0",
            "Diagnostic-Code": "smtp;550 5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors",
            "Original-Recipient": "rfc/822;lead@realty.example",
            "Final-Recipient": "rfc/822;lead@realty.example",
          },
          null,
        ),
      ],
    ),
  );
  const v = classifyBounce(p);
  assert(isBounce(p), "isBounce");
  assert(v.severity === "hard" && v.bounceClass === "invalid_address", `hard / invalid_address (got ${v.severity}/${v.bounceClass})`);
  assert(v.code === "5.4.1", `specific 5.4.1 from the diagnostic beats a generic 5.0.0 (got ${v.code})`);
  assert(extractFailedRecipient(p) === "lead@realty.example", "recipient from rfc/822 Original-Recipient");
  assert(p.dsn.originalMessageIds.length === 0, "no original message attached: attribution falls to the recipient");
}

// ---------- 7. auth failure that also says "spam" ----------
console.log('\n■ Gmail 5.7.26 (text also says "spam") → auth_failure');
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Failure)", "<orig-7@mail.gmail.com>"), [
      deliveryStatus(
        {},
        "Final-Recipient: rfc822; x@y.example\nAction: failed\nStatus: 5.7.26\nDiagnostic-Code: smtp; 550-5.7.26 This message does not have authentication information or fails to pass authentication checks (SPF or DKIM). To best protect our users from spam, the message has been blocked.",
      ),
    ]),
  );
  const v = classifyBounce(p);
  assert(v.bounceClass === "auth_failure", `auth_failure (got ${v.bounceClass})`);
}

// ---------- 8. Gmail refuses as unsolicited ----------
console.log("\n■ Gmail 5.7.1 unsolicited → spam_block");
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Failure)", "<orig-8@mail.gmail.com>"), [
      deliveryStatus({}, "Action: failed\nStatus: 5.7.1\nDiagnostic-Code: smtp; 550-5.7.1 Our system has detected that this message is likely unsolicited mail."),
    ]),
  );
  assert(classifyBounce(p).bounceClass === "spam_block", "spam_block");
}

// ---------- 9. a relay report is not a failure ----------
console.log("\n■ Action: relayed → none");
{
  const p = parseGmailMessage(
    msg(GMAIL_DSN_HEADERS("Delivery Status Notification (Relay)", "<orig-9@mail.gmail.com>"), [
      deliveryStatus({}, "Final-Recipient: rfc822; x@y.example\nAction: relayed\nStatus: 2.0.0"),
    ]),
  );
  assert(classifyBounce(p).severity === "none", "severity none");
}

// ---------- 10. References ranking without an exact id ----------
console.log("\n■ References only → the direct parent (last listed) ranks first");
{
  const p = parseGmailMessage(
    msg(
      {
        From: "postmaster@old-mta.example",
        Subject: "Returned mail: see transcript for details",
        "Content-Type": "multipart/report; report-type=delivery-status",
        References: "<step0@x.example> <step1@x.example> <step2@x.example>",
      },
      [deliveryStatus({}, "Action: failed\nStatus: 5.1.1")],
    ),
  );
  assert(p.dsn.originalMessageIds[0] === "<step2@x.example>", `step2 first (got ${p.dsn.originalMessageIds[0]})`);
}

// ---------- 11. not a bounce ----------
console.log("\n■ an ordinary reply is not a bounce");
{
  const p = parseGmailMessage({
    id: "r1",
    threadId: "t1",
    payload: {
      mimeType: "text/plain",
      filename: "",
      headers: h({ From: "Jane <jane@realty.example>", Subject: "Re: undeliverable package question", "In-Reply-To": "<orig@mail.gmail.com>" }),
      body: { size: 5, data: b64("Sure, call me Tuesday.") },
    },
  });
  assert(!isBounce(p), "isBounce false (subject match is anchored)");
  assert(p.dsn.action === null && p.dsn.status === null, "no DSN fields on ordinary mail");
}

// ---------- summary ----------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
