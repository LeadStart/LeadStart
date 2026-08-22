---
name: project_no_warmup_pool_deliberate
description: LeadStart has no email warmup pool on purpose — the 5→+1/day→20 ramp + inbox-health monitoring is the evidence-backed alternative, not a missing feature
metadata:
  type: project
---

LeadStart's native Gmail channel deliberately has **no automated warmup pool** (the reciprocal shared-inbox networks Instantly/Smartlead/Mailreach run). This is a considered decision, not an unbuilt feature.

**Why:** 2025–2026 evidence is that synthetic reciprocal-pool warmup is noise-to-liability. Google forced GMass (the largest warmup network) to shut its warmup system on 2023-01-31 or lose Gmail API access, and treats automated warmup as a ToS violation; Apollo dropped its own warmup in 2024 for volume-only pacing; independent-leaning tests find no Postmaster reputation lift; open pools admit burner accounts and their "health score" reflects pool engagement, not real inbox placement. Google's own guidance endorses only a *gradual real-volume ramp to engaged recipients* — which is the half of "warmup" that survives modern filtering.

**Our alternative (what we do instead):** per-mailbox volume ramp 5 → +1/day → 20/day hard ceiling ("ramp as data", keyed to cumulative sends — see [[project_contact_status_source_of_truth]] siblings in `src/lib/gmail/ramp.ts`), business-hours pacing, plus hourly inbox-health scoring (SPF/DKIM/DMARC/MX + Spamhaus DBL + 7-day hard-bounce rate, auto-pause). Sending over Google's IPs also dodges the shared-pool IP-contamination risk entirely.

**How to apply:** If asked to "add warmup" or compare to Instantly, do NOT propose a warmup pool.

**On unsubscribe — do NOT add one-click List-Unsubscribe headers or body unsub links to this channel.** Primary-source verified 2026-08-19 (Google/Yahoo/Microsoft sender guidelines): one-click unsubscribe is required only for BULK senders — 5,000+ messages/day to personal Gmail accounts — of MARKETING/subscribed mail. LeadStart sends ~26/day/domain of 1:1 B2B cold outreach (~200x under the threshold, wrong message category), so it categorically does not apply. Worse for deliverability: Gmail ignores List-Unsubscribe headers on Gmail-to-Gmail sends (GMass confirms in testing — same Gmail-API-from-Workspace architecture we use), so the header is inert for a large share of sends; and a lone tracked unsubscribe *link* in the body is a known cold-email spam signal. Reply-based opt-out language (what we do) satisfies CAN-SPAM — the FTC explicitly allows a reply mechanism as a valid opt-out. Daniel pushed back hard on the earlier "add unsub" suggestion and was right.

**The real, evidence-backed gaps to close instead (ranked):** (1) pre-send email verification at import — none exists today; this is the one non-tainted capability Instantly has that we don't (their warmup pool is tainted, blacklist-monitoring + auto-pause we already match); (2) Google Postmaster Tools spam-rate visibility (needs ~100+/day/domain to populate — revisit at ~5x current volume); (3) seed/placement spot-checks — **SHIPPED 2026-08-22** as seed inboxes + placement tests (migration `00068`, see [[project_seed_placement_tests]]); still a spot-check, not a gate — a 3–5 seed panel alone can only take a mailbox to "watch", never "critical".

**SHIPPED 2026-08-19** (code local, pending migration `00067` apply + deploy): fallback-bounce send-row accuracy fix (bounces were undercounted ~4x — DSNs that don't thread-match now mark the send row, not just the contact), soft-bounce tally + warn-only health signal, widened bounce search to include the spam folder, DMARC `p=none`→warn grading in `check.ts`, and a reply-signal health component (0 replies at ≥40 sends/14d → warn). Full research: 2026-07-13 + 2026-08-19 sessions.
