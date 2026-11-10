#!/usr/bin/env node
/**
 * Tests for follow-up alerts (src/lib/replies/follow-up-rules.ts, migration
 * 00142): what counts as a follow-up (anything after the lead's first reply in
 * a conversation, owner pick 2026-11-09), which replies one pass alerts (this
 * one, plus later ones that came in within the hour and weren't alerted, for
 * when the poller takes the newer message first), and the owner email. Pure: no
 * network, no DB.
 *
 * Usage:
 *   npx tsx scripts/test-follow-up-alerts.ts
 */

import {
  EMAIL_BODY_MAX,
  FOLLOW_UP_SWEEP_MS,
  buildFollowUpEmail,
  classLabel,
  followUpWho,
  followUpsToAlert,
  isFollowUp,
  type ConversationReply,
} from "../src/lib/replies/follow-up-rules.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const NOW = Date.parse("2026-11-10T07:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
function row(id: string, receivedMinAgo: number, opts: { landedMinAgo?: number; alerted?: boolean } = {}): ConversationReply {
  return {
    id,
    received_at: ago(receivedMinAgo),
    created_at: ago(opts.landedMinAgo ?? receivedMinAgo),
    follow_up_alerted_at: opts.alerted ? ago(1) : null,
  };
}

console.log("what counts as a follow-up:");
const first = row("first", 60 * 24 * 4);
const second = row("second", 2);
assert(!isFollowUp([first], "first"), "a lead's only reply is not a follow-up");
assert(!isFollowUp([first, second], "first"), "their first reply is not, even with a later one on file");
assert(isFollowUp([first, second], "second"), "anything after it is");
assert(isFollowUp([second, first], "second"), "whatever order the rows come back in");
assert(!isFollowUp([first, second], "missing"), "a reply not in the conversation is not");
const tieA = { ...row("a", 5), created_at: ago(5) };
const tieB = { ...row("b", 5), created_at: ago(4) };
assert(isFollowUp([tieB, tieA], "b") && !isFollowUp([tieB, tieA], "a"), "same received time: the one that landed first is the first");

console.log("\nwhich replies one pass alerts:");
assert(same(followUpsToAlert([first], "first", NOW), []), "a lone first reply alerts nothing");
assert(same(followUpsToAlert([first, second], "second", NOW), ["second"]), "a follow-up alerts itself");
assert(same(followUpsToAlert([first, second], "first", NOW), ["second"]), "the poller took the newer one first: the older one's pass alerts it");
assert(
  same(followUpsToAlert([first, { ...second, follow_up_alerted_at: ago(1) }], "first", NOW), []),
  "an alerted reply is never alerted again",
);
const stale = row("stale", 60 * 24, { landedMinAgo: FOLLOW_UP_SWEEP_MS / 60_000 + 5 });
assert(same(followUpsToAlert([first, stale], "first", NOW), []), "a later reply that landed over an hour ago is left alone");
assert(same(followUpsToAlert([first, stale], "stale", NOW), ["stale"]), "but its own pass still alerts it");
const third = row("third", 1);
assert(
  same(followUpsToAlert([third, first, second], "third", NOW), ["second", "third"]),
  "several waiting: oldest first",
);
assert(
  same(followUpsToAlert([first, row("old", 60 * 24 * 2, { alerted: true }), second], "second", NOW), ["second"]),
  "one alerted before: only the new one",
);

console.log("\nthe owner email:");
const reply = {
  lead_name: "Mark Lindquist",
  lead_company: "Lindquist Law",
  lead_email: "mark@lindquist.example",
  subject: "Re: AI visibility",
  body_text: "Thanks, I'll look at it next week.\r\n\r\nOn Tue, Oct 21, 2026 at 10:46 AM Daniel <daniel@tube.example> wrote:\r\n> Here's the report",
  final_class: "objection_timing" as const,
  received_at: ago(2),
};
const email = buildFollowUpEmail({
  reply,
  campaignName: "TuBe SEO",
  clientName: "SaaSassins",
  inboxUrl: "https://app.example/app/admin/inbox/r1",
});
assert(email.subject === "Follow-up from Mark Lindquist (Lindquist Law): TuBe SEO", "subject names who and the campaign");
assert(email.html.includes("Thanks, I&#39;ll look at it next week."), "quotes what they wrote");
assert(!email.html.includes("Here&#39;s the report"), "without the quoted thread under it");
assert(email.html.includes("Timing Concern"), "says how it was read");
assert(email.html.includes('href="https://app.example/app/admin/inbox/r1"'), "links to the reply in the Inbox");
assert(!email.html.includes("—"), "no em dashes in its words");
const evil = buildFollowUpEmail({
  reply: { ...reply, lead_name: "<script>x</script>", body_text: "<b>hi</b>" },
  campaignName: "C",
  clientName: null,
  inboxUrl: "https://app.example/x",
});
assert(!evil.html.includes("<script>") && !evil.html.includes("<b>hi</b>"), "what a lead wrote is escaped");
assert(!evil.html.includes(">Client<"), "a missing client is left out");
const long = buildFollowUpEmail({
  reply: { ...reply, body_text: "word ".repeat(2000) },
  campaignName: "C",
  clientName: null,
  inboxUrl: "https://app.example/x",
});
assert(long.html.length < EMAIL_BODY_MAX + 2000 && long.html.includes("…"), "a long reply is cut short");
const empty = buildFollowUpEmail({
  reply: { ...reply, body_text: "" },
  campaignName: "C",
  clientName: null,
  inboxUrl: "https://app.example/x",
});
assert(empty.html.includes("Re: AI visibility"), "an empty body falls back to the subject");

console.log("\nnames and labels:");
assert(followUpWho({ lead_name: null, lead_company: null, lead_email: "a@b.example" }) === "a@b.example", "no name: the address");
assert(followUpWho({ lead_name: "  ", lead_company: "Ajax", lead_email: "a@b.example" }) === "a@b.example (Ajax)", "blank name: the address, with the company");
assert(classLabel("ooo") === "Out of Office", "an auto-reply reads as Out of Office");
assert(classLabel(null) === "Not read yet", "not classified yet");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
