---
name: project_no_warmup_pool_deliberate
description: LeadStart has no email warmup pool on purpose — the 5→+1/day→20 ramp + inbox-health monitoring is the evidence-backed alternative, not a missing feature
metadata:
  type: project
---

LeadStart's native Gmail channel deliberately has **no automated warmup pool** (the reciprocal shared-inbox networks Instantly/Smartlead/Mailreach run). This is a considered decision, not an unbuilt feature.

**Why:** 2025–2026 evidence is that synthetic reciprocal-pool warmup is noise-to-liability. Google forced GMass (the largest warmup network) to shut its warmup system on 2023-01-31 or lose Gmail API access, and treats automated warmup as a ToS violation; Apollo dropped its own warmup in 2024 for volume-only pacing; independent-leaning tests find no Postmaster reputation lift; open pools admit burner accounts and their "health score" reflects pool engagement, not real inbox placement. Google's own guidance endorses only a *gradual real-volume ramp to engaged recipients* — which is the half of "warmup" that survives modern filtering.

**Our alternative (what we do instead):** per-mailbox volume ramp 5 → +1/day → 20/day hard ceiling ("ramp as data", keyed to cumulative sends — see [[project_contact_status_source_of_truth]] siblings in `src/lib/gmail/ramp.ts`), business-hours pacing, plus hourly inbox-health scoring (SPF/DKIM/DMARC/MX + Spamhaus DBL + 7-day hard-bounce rate, auto-pause). Sending over Google's IPs also dodges the shared-pool IP-contamination risk entirely.

**How to apply:** If asked to "add warmup" or compare to Instantly, do NOT propose a warmup pool. The real, evidence-backed gaps to close instead (ranked): (1) one-click unsubscribe headers — `src/lib/gmail/mime.ts` currently adds none; (2) pre-send email verification at import — none exists today; (3) Google Postmaster Tools spam-rate visibility (needs multiple inboxes per domain to populate ~100+/day); (4) DMARC policy-strength grading + root-domain flag in `check.ts`; (5) seed/placement spot-checks (spot-check, not a gate — panels are weak proxies at ~20/day). Full research: 2026-07-13 session.
