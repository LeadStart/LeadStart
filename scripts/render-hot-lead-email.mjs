#!/usr/bin/env node
// Renders the REAL buildClientNotificationEmail() in three states to
// public/hot-lead-email-preview{,-2,-3}.html so the browser preview can verify
// parity with the approved mockup.
//
// Usage: npx tsx scripts/render-hot-lead-email.mjs

import { writeFileSync } from "node:fs";

const { buildClientNotificationEmail } = await import(
  "../src/lib/notifications/client-email.ts"
);

const now = new Date().toISOString();
const THREAD = "https://leadstart-ebon.vercel.app/app/client/inbox/demo?token=FAKE";

const states = [
  {
    file: "public/hot-lead-email-preview.html",
    data: {
      leadName: "Sarah Chen",
      leadTitle: "VP of Operations",
      leadCompany: "Acme Corp",
      leadEmail: "sarah.chen@acmecorp.com",
      leadPhone: "+1 (415) 555-0142",
      leadLinkedinUrl: "https://linkedin.com/in/sarahchen",
      replySubject: "Re: Cutting Acme's fulfillment costs ~20%",
      replyBodyPreview:
        "Thanks for reaching out — this is actually really timely. We just wrapped a board review and lead gen was flagged as a gap. Can you do a quick call tomorrow afternoon? I'm free after 2pm PT. Also curious how you'd handle our EU entity — we've had compliance headaches there before.",
      replyThreadUrl: THREAD,
      receivedAt: now,
    },
  },
  {
    file: "public/hot-lead-email-preview-2.html",
    data: {
      leadName: "Marcus Webb",
      leadTitle: "Head of Facilities",
      leadCompany: "Brightline Logistics",
      leadEmail: "marcus.webb@brightline.io",
      leadPhone: null,
      leadLinkedinUrl: null,
      replySubject: "Re: Reducing pallet-handling costs",
      replyBodyPreview:
        "This is interesting timing — we're reviewing our 3PL contracts next month. I don't have a direct line handy, but email me and we can set something up. What kind of savings do you typically see for a fleet our size?",
      replyThreadUrl: THREAD,
      receivedAt: now,
    },
  },
  {
    file: "public/hot-lead-email-preview-3.html",
    data: {
      leadName: null,
      leadTitle: null,
      leadCompany: "Sparkle Clean Co",
      leadEmail: "info@sparkleclean.com",
      leadPhone: "+1 (214) 555-0198",
      leadLinkedinUrl: null,
      replySubject: "Re: Cutting your cleaning-supply costs",
      replyBodyPreview:
        "Thanks for reaching out — yes, we'd be open to hearing more about your cleaning-supply program. Can you send over pricing, or let us know a good time to call this week?",
      replyThreadUrl: THREAD,
      receivedAt: now,
    },
  },
];

for (const { file, data } of states) {
  const { subject, html } = buildClientNotificationEmail(data);
  writeFileSync(file, html);
  console.log(`${file}\n  Subject: ${subject}`);
}
