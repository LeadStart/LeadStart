# Unfair Advantages — LeadStart Sending Platform

> **Working strategy doc.** The eventual goal: turn LeadStart's sending engine into a
> **self-serve platform that replaces Instantly.ai** (and Smartlead / Apollo / lemlist).
> This file captures the advantages that are genuinely *hard to copy* — the reasons a
> customer leaves Instantly for us. Lead with deliverability; that's the moat.
>
> Status tags: **[SHIPPED]** = live in how we send today · **[BUILT, gated]** = code-complete,
> waiting on a key/flag · **[ROADMAP]** = designed, not built.
>
> Last updated: 2026-08-26.

---

## The thesis

Instantly, Smartlead, Apollo, lemlist all optimize for the same thing: **volume and
convenience.** Import a list, connect inboxes, blast, buy a warmup add-on, hope. In that
world **deliverability is the *user's* problem** — they're handed the controls *and* the
blame when their domains burn.

LeadStart's bet is the inverse: **deliverability is the platform's job, enforced
automatically in the send path.** The promise isn't "send more" — it's:

> **"Your domains don't get burned, and you never have to become a deliverability
> engineer to keep them alive."**

Almost everything below is *already how we send today* — not a someday feature. That's the
point: our moat is the send engine itself, not the marketing site.

**One-line position:** *Instantly hands you a loaded gun. We hand you a system that won't
let you shoot your own foot.*

---

## 1. Pre-send re-verification, rolling 30 days, fail-closed ⭐ flagship

**[BUILT, gated on MV key]**

**What it is.** Every recipient is verified (Million Verifier) **just before its first
send — not at import.** The verdict caches on the contact (`contacts.email_verified_at`
+ `email_verification_status`) with a **30-day TTL**
([`policy.ts`](src/lib/millionverifier/policy.ts) → `VERIFICATION_TTL_DAYS = 30`,
`isFresh()`). Inside 30 days it's a free cache hit; past 30 days the address is
**re-checked before we'll send to it again**. If the verifier is down or out of credits,
new unverified sends **hold (fail-closed)** and alert the owner — we never silently send
unverified.

**Why it's unfair.** Everyone else verifies **once, at import** (or makes the user do it
themselves and pray). But lists rot ~2–4% *per month* — people change jobs, mailboxes get
deactivated, catch-alls flip. A list verified in January and mailed through March is
firing at an increasingly dead list → **bounce rate climbs → domain reputation
craters → the whole account tanks** — and the user has no idea why. We *structurally
cannot* have that failure mode: no address is ever mailed on a verification older than 30
days, and the gate is fail-closed so it can't quietly degrade into a bounce spiral.

**The subtle part that makes it cheap.** It's per-send *and* cached, so follow-ups to an
already-fresh contact cost nothing, two enrollments sharing a contact in one tick share
the result, and a changed email auto-invalidates the cache (DB trigger
`reset_email_verification_on_email_change`). So we get *always-current* without
*verify-the-whole-list-every-day*.

**Self-serve pitch.** "Instantly makes you verify your list and then watch your bounce
rate. We re-verify every address on a rolling 30 days, automatically, the moment before we
send — so your bounce rate stays low no matter how stale your list gets. You literally
can't send to a dead address here."

---

## 2. Warmup *is* the sender — not a paid add-on

**[SHIPPED]**

**What it is.** A per-mailbox, volume-based warmup ramp is baked into dispatch
([`ramp.ts`](src/lib/gmail/ramp.ts) → `effectiveDailyCap`, keyed off each inbox's
cumulative all-time sends). New mailboxes start low and climb as they prove themselves; no
separate "warmup pool" exists.

**Why it's unfair.** Instantly/Smartlead sell warmup as a **separate paid product** — a
pool of bots emailing each other to fake reputation, which providers increasingly detect
and discount. We don't need it: real ramped sending + inbox-health monitoring (below) does
the job with *real* signal. One fewer add-on to buy, one fewer thing to detect. (Deliberate
design call — the ramp + monitoring replaces warmup pools *on purpose*.)

---

## 3. Inbox-health monitoring + auto-pause

**[SHIPPED]**

**What it is.** An hourly per-mailbox health score (`check-inbox-health` cron) fused from
DNS (SPF/DKIM/DMARC), blacklist checks, bounce rate, reply rate, and seed-placement
results. Bad signals throttle or pause a mailbox before it drags a domain down.

**Why it's unfair.** Most tools show you a dashboard *after* the damage. Ours is a
closed-loop control on the send path — the platform reacts, not just reports.

---

## 4. Seed-placement testing — direct Inbox/Spam measurement

**[BUILT, gated]**

**What it is.** We send this campaign's real copy to **seed inboxes we control** and read
back where it actually landed — **Inbox / Promotions / Spam** — plus receiver-side
SPF/DKIM/DMARC (migration 00068, `run-placement-tests`, per-mailbox + per-copy probes).

**Why it's unfair.** Everyone else *infers* deliverability from opens (which Apple/Google
have made noise) or from spam-word scores. We take a **direct physical measurement** of
placement, on the actual copy, before a prospect ever sees it. That's a different category
of confidence.

---

## 5. Domain burn-prevention + lifecycle (drain mode)

**[SHIPPED]**

**What it is.** Sending domains carry a lifecycle + health rollup (`sending_domains`,
migration 00081). Tired/resting domains are **excluded from new first-touches** (drain
mode) while their in-flight threads finish — so a struggling domain cools off instead of
getting pushed over the edge.

**Why it's unfair.** Instantly will happily let you keep blasting a smoking domain until
it's dead. We actively protect the asset — the domains *are* the business, and the
platform treats them that way.

---

## 6. Volume discipline enforced, not suggested

**[SHIPPED]**

**What it is.** Hard ceilings baked into the sender: ~25/day/inbox, a per-domain daily cap,
scale **by adding domains, not by cranking one**. The caps aren't a "best practice" in a
help doc — they're enforced in the dispatch loop.

**Why it's unfair.** The #1 way users torch themselves on Instantly is turning the volume
knob to 11. We remove the footgun: you *can't* over-send a domain here, so the naive-user
failure mode is designed out.

---

## 7. Native Gmail-API sending (not SMTP relay)

**[SHIPPED]**

**What it is.** We send **directly from Google Workspace inboxes via the Gmail API** —
proper threading (`Re:` on the same thread, real `In-Reply-To`/`References`), the account's
own reputation, no third-party relay in the path.

**Why it's unfair.** SMTP-relay tools inherit shared-IP reputation and leave a relay
footprint. Sending as the actual mailbox, through Google's own API, is as close to "a human
sent this from their inbox" as automated outreach gets.

---

## 8. Correct suppression, scoped per client

**[SHIPPED]**

**What it is.** The send loop halts on reply, bounce, and unsubscribe, and honors a
**per-client DNC list** (an opt-out is scoped to the client the person replied to; org-wide
entries supported). Reply ingestion runs independently of campaign status, so a reply
during a pause still stops that lead.

**Why it's unfair.** Suppression done wrong is how you email someone who already said no —
a compliance and reputation landmine. Ours is correct *and* multi-tenant-aware from the
start.

---

## 9. AI reply pipeline — classification + hot-lead alerts

**[SHIPPED]**

**What it is.** A two-layer classifier (keyword prefilter → Claude Haiku) tags every
inbound reply and fires a hot-lead notification, channel-agnostic
([`runReplyPipeline`](src/lib/replies/pipeline.ts)). Positive replies peel out of the
sequence automatically.

**Why it's unfair.** Instantly gives you a unibox; you still triage manually. We surface
the *hot* replies instantly and take the lead out of the machine so it never gets mailed
again — outcomes, not just an inbox.

---

## 10. Flow sequences: branching + internal automations

**[SHIPPED: authoring · ROADMAP: execution]**

**What it is.** The new visual Flow builder authors branching decision trees (reply/open
conditions), mixed channels (email now, LinkedIn-manual next), and **internal automations**
(notify the AM in Slack, create a task, webhook) — the graph persists in `campaigns.flow_graph`
while the sender runs the derived linear steps.

**Why it's unfair.** Instantly's sequences are basically a linear drip. "When they reply,
ping my account manager and stop mailing them" is a first-class element here. This is where
the product goes from *sender* to *outreach OS*.

---

## What this means for self-serve

The wedge for a self-serve launch is a single, credible promise Instantly can't make with a
straight face: **"We keep your domains alive for you."** Every advantage above is evidence
for that one sentence. The marketing writes itself:

- *"Never send to a dead address."* (#1)
- *"No warmup add-on to buy."* (#2)
- *"We measure real inbox placement, not opens."* (#3, #4)
- *"We won't let you burn a domain."* (#5, #6)
- *"Sends like a human, from your own inbox."* (#7)

Pricing angle: because deliverability is the platform's job, we can charge for the
*outcome* (protected domains + reply/meeting outcomes) rather than renting inbox slots and
warmup by the seat.

---

## Honest status — what self-serve still needs

Being straight about the gap between "great send engine" and "self-serve product":

- **Billing / metering** — Stripe is a placeholder; no self-serve plans or usage metering yet.
- **Onboarding + domain/inbox provisioning at scale** — today buildouts are owner-run;
  self-serve needs a guided connect + (ideally) automated domain/mailbox provisioning.
- **Branch/automation execution** — #10's *authoring* is shipped; actually *running*
  conditions, LinkedIn-manual tasks, and internal automations is the next engineering phase.
- **Multi-tenant hardening** — RLS + per-org isolation exist; a public self-serve surface
  raises the bar (abuse, spam-sender onboarding, credit theft).
- **The verification key economics** — #1's fail-closed gate depends on MV credits; at
  self-serve scale, pass-through vs. bundled pricing needs a model.

**Proven vs aspirational:** #1–#9 are real and mostly running against production today;
#10-execution and everything in this section are the build-out. Keep this doc honest — an
"advantage" only counts once it's in the send path.

---

## Add your own

This is a living doc — drop new advantages here as we find them, and demote any that turn
out to be table-stakes. The bar for this list: *would a competitor find it genuinely hard
to copy, and does it ladder up to "we keep your domains alive"?*
