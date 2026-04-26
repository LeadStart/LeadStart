#!/usr/bin/env node
// Renders the hot-lead notification email with fake data to public/hot-lead-email-preview.html
// so the browser preview tool can verify the change.
//
// Usage: npx tsx scripts/render-hot-lead-email.mjs

import { writeFileSync } from "node:fs";

const { buildClientNotificationEmail } = await import(
  "../src/lib/notifications/client-email.ts"
);

const { subject, html } = buildClientNotificationEmail({
  leadName: "Sarah Chen",
  leadCompany: "Acme Corp",
  leadPhone: "+1 (415) 555-0142",
  classLabel: "Interested",
  replyBodyPreview:
    "Thanks for reaching out — this is actually really timely. We just wrapped a board review and cold outreach is one of the gaps. Can you do a quick call tomorrow afternoon?",
  dossierUrl: "https://leadstart-ebon.vercel.app/app/client/inbox/demo?token=FAKE",
  portalUrl: "https://leadstart-ebon.vercel.app/app/client/inbox/demo",
  receivedAt: new Date().toISOString(),
});

writeFileSync("public/hot-lead-email-preview.html", html);
console.log("Subject:", subject);
console.log("Wrote public/hot-lead-email-preview.html");
