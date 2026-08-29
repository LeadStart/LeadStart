# TuBe SEO launch — cold outbound sequence (3-step email + LinkedIn fork)

> Drafted 2026-08-25 · **Rev 2026-08-26: the two-arm offer-placement test is replaced
> by a four-angle A/B/C/D test (owner call), and positioning is verified against the
> live site gotubeseo.com.** Local-only, not committed. Copy is written to run on
> LeadStart's native Gmail channel exactly as pasted — real `{{token}}` names,
> `{spintax|blocks}` the engine resolves deterministically, 3-day `wait_days`
> spacing, reply-based CTAs (the platform measures replies, not opens). Research
> digest in §2 is cited; every number carries its source.

## 0. As-built in LeadStart (2026-08-26) — supersedes the "8 campaigns" framing below

A **draft** campaign is live in the app (nothing sends; drafts are inert until
launch-readiness passes + explicit activation):

- **Name:** `TuBe SEO — AI Visibility Launch (A/B/C/D + LinkedIn)`
- **ID:** `a23526b3-1858-40b1-9726-3d8a5c952644` · status `draft` · `native_email` ·
  no client / mailboxes yet (both are launch-blockers surfaced by launch-readiness).
- **Open it:** Admin → Campaigns → that name (the Sequence tab shows the flow).

**Capability correction (important):** §4/§5 below were written assuming "the platform
has no in-campaign variants, so each angle is its own campaign" (→ 8 campaigns). That
is **outdated** — the visual Flow builder (`flow_graph`, migration 00086+) supports
**in-campaign A/B/C/D email variants** (per-variant subject+body, `native_sends.variant_id`
measurement, opt-in auto-winner) **and condition forks** on reply signals **and**
LinkedIn/internal nodes. So the as-built is ONE campaign, not eight:

- **Email 1 = a single node carrying 4 variants** = the four angles (A Mention Gap /
  B Market shift / C Found a problem / D Mini-report), each its own subject + body.
  This is the only variable under test; the sender splits enrollments across the four
  and measures per variant.
- **Reply-interested condition fork** after email 1 → **yes:** an internal "notify"
  (hot lead — send the report); **no:** the follow-up branch.
- **Shared, complete Email 2 and Email 3** (in the no-branch), not per-angle. Why
  shared: variant assignment is `hash(contactId + nodeId)` — **independent per node**
  (`src/lib/flow/variants.ts`), so putting 4 variants on email 2 as well would give a
  lead a *random* angle pairing (e.g. B-then-C), breaking coherence. Instead email 2
  is angle-agnostic and delivers the full payload (competitors + fix + stat) in one
  shot; email 3 is the shared breakup + the free-30-min-review door. This is cleaner
  experimental design anyway: the opening angle is isolated as the single variable.
- **LinkedIn fork** = `connect_request` (blank) + two `message` nodes interleaved in
  the no-branch. Authored now; they persist but do **not** execute until the flow
  branch-execution phase ships (and Unipile is activated) — exactly the plan's gating.
- **Variable registry auto-seeded** from the copy: `first_name, company, buyer_question,
  competitors, competitor_1, city, fix_line` — these are the CSV columns the import
  panel will require (all pre-rendered per contact from the pre-run scan; §5).

**How the A/B/C/D test now runs (revises §4 Axis 3 + §9):** don't build 8 campaigns —
build this ONE and let the email-1 variant split BE the test (25/25/25/25 automatically,
no mod-4 CSV rotation needed). Turn on the campaign's A/B auto-winner
(`ab_auto_pause_default`, off by default) if you want it to auto-pause losing angles on
positive-reply rate; otherwise read `native_sends.variant_id` stats and call it by hand.
The **cohort** split (Named vs Generic-inbox) is still a real reason for a **second
campaign** — different line-1 greeting + a separate mailbox pool — so the practical
launch is **2 campaigns** (Named + Generic), each with the same 4-variant email 1, not 8.
The 8-campaign matrix below is the fallback only if you ever need per-angle email-2
coherence (which requires separate campaigns, since variants can't correlate across steps).

**Signature/CAN-SPAM:** the built copy signs off `{{your_name}} / TuBe SEO` — the
**physical postal address is NOT yet in the bodies** and remains the hard launch blocker
(§8). Add it to all three emails before activation.

---

## 1. What this sells and the one strategic move

**Product:** TuBe SEO — free email-gated scan (costs us ~$0.034/run) that reports DR/UR,
an AI Readiness score + flags, a live AI-visibility probe (one buyer question across
ChatGPT, Perplexity, Gemini, Google AI Overviews, Google AI Mode), and the Mention Gap:
which competitors the AI recommends instead.

**Business reality (verified against gotubeseo.com, 2026-08-26):** the live site sells
**done-for-you SEO from $3,500/mo** (15 services in every plan; agency white-label
from $999/mo), converted through a **free 30-minute review** ("we run your site
through our platform first… you keep the findings whether or not you hire us"). The
site's four checkable differentiators: (1) a human signs off on everything, (2)
page-one pages are protected — the software physically cannot rewrite them, (3)
links/digital PR included in every plan, not an upsell, (4) AI-recommendation
measurement across **six assistants** (ChatGPT, Claude, Perplexity, Gemini, AI
Overviews, AI Mode) with real cost transparency. Funnel: **cold email → free scan
report → free 30-minute review → $3,500/mo engagement.** Unit economics: one signed
client ≈ $42K/yr — one client per ~2,000 cold emails is already a strong campaign,
which is why every arm can afford to give real value away up front.

**ICP:** US local service businesses (med spas, cleaning, HVAC, law firms, home
services) — owner-operators. Sourced from the Maps vein (many are `info@` generic
inboxes; owner reads them) and the LinkedIn vein (named people, personal emails,
LinkedIn profiles).

**The move: pre-run the scan on every prospect before email 1.** At $0.034/scan,
1,000 prospects = $34 of ammunition. That converts the sequence from "we have a free
tool" (commodity) to "I already looked at your business and here is what ChatGPT says
about you" (specific, personal, slightly alarming, verifiably true). The scan output
becomes per-contact merge data: the buyer question we asked, the engine's answer, and
the competitors it named. Nobody in this market is doing personalized-audit outreach
at SMB price points (§2.1).

The test (rev 2026-08-26) is a **four-angle A/B/C/D**: same pre-run data and the
same "send it" CTA in every arm, but four different opening frames — competitor
loss, market shift, concrete defect, and a give-first mini-report (§5). Every arm
demonstrates value by quoting real findings rather than claiming capability.

## 2. Research digest (deep-dive, 2026-08-25)

### 2.1 The market and TuBe's lane

The category has no settled name — practitioners say **GEO** (Generative Engine
Optimization), with AEO/LLMO/AIO competing; buyers say "ChatGPT"/"AI search"
(Contently Apr 2026; Forbes Aug 2026; Rankability 2026). The tracker market clusters
at **$79–$499+/mo selling to brands, SaaS teams, and agencies**: Profound ($99 entry,
realistic $399+, enterprise, ~$1B valuation), Peec AI (~€89–199, mid/agency), AthenaHQ
(~$295), Semrush AI Toolkit ($99/domain, real-world $300+), Ahrefs Brand Radar ($199
atop $129 base), SE Ranking (~$189–218), Rankscale (~$79), Scrunch/BrandLight
(enterprise, opaque). Near SMB price points there are exactly two: **Otterly.ai**
($29/mo, horizontal self-serve, no authority metrics) and **Local Falcon** ($24.99/mo,
local geo-grid SAIV score, GBP/agency-oriented, setup-heavy). A swarm of free
micro-checkers (Semrush's and Ahrefs' free visibility checkers, Geoptie, PromptRush,
GoVISIBLE…) proves the free-scan motion — but **every one of them is inbound/PLG**.

**The open lane TuBe occupies:** nobody combines authority metrics (DR/UR) +
technical AI-readiness audit + live multi-engine probe + a *named-competitor* Mention
Gap in one scan — and nobody delivers it **outbound** to local owner-operators. The
competitor-comparison frame is validated in-product and in media ("ChatGPT Recommends
Competitors" — DesignRush; "Your Competitor Is Getting Customers from ChatGPT" —
Bitzburg) but unused as a personalized cold hook. One caveat the copy respects:
generic "GEO outreach" spam fatigue is already real, so the emails must read as
evidence, not category pitch (§3).

### 2.2 Stats safe to use in copy (each verified, with source)

| Stat | Number | Source, date |
|---|---|---|
| **Consumers asking AI for local recommendations** | **45% in the past year, up from 6% the year before** (64% among ages 30–44) | BrightLocal Local Consumer Review Survey, 2026 — the anchor stat, used in email 2 |
| AI Overviews on local-business queries | avg **68%** of local queries; 92–97% of informational/hybrid ("best med spa for…"), only 15% of direct "plumber in phoenix" | Whitespark, May 2025 |
| Click behavior under AI summaries | users click a result on **8% of searches with an AI summary vs 15% without** (~half); links inside the summary: 1% | Pew Research Center, Jul 2025 |
| CTR loss for #1 organic under AIO | **−34.5%** (Apr 2025, 300k keywords) → **−58%** (Dec 2025 dataset) | Ahrefs |
| Zero-click searches | **68.0%** of US Google searches end with no click (Jan–Apr 2026); ~83% when an AIO is present | SparkToro/Datos, 2026 |
| ChatGPT scale | ~800M weekly users (Oct 2025) → ~1B (Aug 2026); ~2.5B prompts/day | OpenAI via DemandSage/Backlinko |
| AI-referred visitor quality | Semrush: worth ~4.4× an organic visitor; Ahrefs: 0.5% of traffic → 12.1% of signups. **Directional only — don't promise multipliers** (Amsive found no significant overall difference) | Semrush Jun 2025; Ahrefs 2025 |
| Honesty checks | AI referrals ≈ 1% of total site visits today (Digiday/Similarweb 2025); 53% of consumers distrust AI results (Gartner 2025) | keeps the pitch calibrated |

### 2.3 Free-scan GTM benchmarks

- **Graders are a proven acquisition engine**: HubSpot Website Grader graded 4M+
  sites 2006–11 and fed HubSpot's early growth (instant score + email-gated full
  report + self-qualification); Ubersuggest generates ≥100K leads/month; SEOptimer
  white-labels its audit widget to **2,000+ agencies at $39–59/mo**. Notably,
  **HubSpot just launched an AEO Grader** — incumbent validation of AI-visibility
  grading, and a reason to move fast in the local-SMB lane it won't serve well.
- **Pre-personalized audit outreach is the top-performing cold pattern on record**:
  audit-led cold email runs **6–15% reply vs the 1–3% generic baseline** (2026
  workflow guides); signal-led personalization measured **11.2% vs 2.1% generic
  (5.3×)**; Woodpecker's 20M-email dataset shows up to +142% reply from
  personalized subject+body; personalized *video* audits (the manual, 5–15-min-labor
  version of what TuBe's $0.034 scan automates) run 15–20% reply vs 1–5% text-only.
  No published head-to-head exists on "already ran it" vs "want me to run one?" —
  adjacent evidence favors **leading with the finding** (specificity is the
  credibility signal), which is why every angle in §5 leads with the offer and
  real findings; the A/B/C/D tests the opening *frame*, not the placement.
- **Fear needs a fix**: the Tannenbaum et al. meta-analysis (127 studies) — fear
  appeals reliably move behavior and almost never backfire **when paired with an
  efficacy statement** (a clear, doable fix). Design rule baked into the copy: the
  gut-punch is always followed by "here's the fixable reason" (`{{fix_line}}`).
  Negative framing also outperforms positive in headline-scale data (Outbrain 65K
  headlines: negative superlatives +63% CTR).
- **Gate design (product-side)**: best practice is teaser-then-gate for inbound
  (show the score, gate the full report; email-only single-field forms convert
  ~23%, ~3× four-field forms) — but **cold-email recipients should get a tokenized
  UNGATED result link** (we already hold their email; friction only costs us the
  gut-punch). This upgrades §10's open item from "nice to have" to evidence-backed.
- **Conversion modeling**: freemium median free→paid is 2.6% (OpenView/ProfitWell);
  model **0.5–1.5% of cold-pushed scans → paid in 90 days** as base case, 2–4% for
  inbound scans, and treat "opened report + viewed competitor section + returned"
  as a PQL worth manual follow-up (that segment converts 10–25%). At $0.034/scan,
  tool cost per customer is ~$7 even at 0.5% — list quality and deliverability are
  the real constraints, not scan cost.
- **Pricing psychology for this buyer** (context — note the live site sells DFY at
  $3,500/mo via a free review, not self-serve SaaS; this bullet describes a
  *possible future* self-serve tier, not today's funnel): charm-priced $29–49
  entry / $79–99 fix-guidance tier / $199+ anchor; the $29–99 plain-language slot
  for local owner-operators is **empty** in this category. Owner-operators favor
  month-to-month and trust one-time purchases — a hybrid (one-time deep report →
  monthly monitoring) fits, and AI answers changing monthly makes monitoring
  inherently subscription-shaped.
- **Second GTM lane worth parking**: the SEOptimer model — white-label the TuBe
  scan to marketing agencies serving local businesses (embeddable widget,
  $39–59/mo × agencies). Same engine, different buyer; roundup data credits
  embedded audit widgets with ~4× the capture of static lead magnets.

### 2.4 Claims to avoid (contested/debunked)

- Gartner's "search volume drops 25% by 2026" — didn't happen; publicly debunked (SEJ). Never cite.
- "AI search overtakes Google by 2028" — a Semrush *projection*; label as prediction or skip.
- Hard conversion multipliers (4.4×/23×) — contested; say "tend to convert better."
- "Half of Google searches show AI answers" — trackers disagree (Semrush ~16% vs BrightEdge ~48%); for this ICP use Whitespark's local 68% with its intent caveat.
- Pew's finding is safe cited *as Pew's finding* — Google disputes the methodology.
- "SEO is dead" — AI referrals ≈1% of visits; savvy owners smell the overclaim.

### 2.5 Cold-outbound mechanics (email + LinkedIn)

- **Reply-rate reality (measurement matters):** platform-wide average 3.43%, top
  quartile 5.5%+, top decile 10.7%+ (Instantly 2026 report, billions of sends);
  Belkins' stricter net-new-contact count is 0.45% — but **owners/founders reply
  most, and 0–10-employee companies are the single highest-replying size band**
  (Belkins 2026, 7.5M emails). Micro-SMB owner ICPs skew above average because the
  decision-maker reads their own mail. Healthy positive share: 40–60% of replies.
- **3 emails is the right length:** 1→2 emails +60% replies, 3 emails 5.8% vs 3.0%
  single; **beyond 3 follow-ups replies decline while spam complaints rise** (Unify
  2026). ~58% of replies come on step 1 (Instantly); the first follow-up is often
  the strongest single step (Woodpecker 20M). Day 0/3/6 spacing sits inside the
  evidence band (2–4 day gaps; ~90% of replies to a send arrive within 2 days).
- **Short copy wins:** 50–125 words = 8.2% reply vs 3.9% at 200–300 (4M+ email
  roundup); Gong (28M): <100 words, and "the moment you pitch, replies drop up to
  57%." Every template below is 50–90 words.
- **Subjects:** 1–4 words, all-lowercase outperforms title case (Smartlead, 85M);
  question-form wins opens (Belkins 46%) but **plain internal-memo style wins
  conversations** — and with no open tracking, replies are the only metric.
- **CTA:** Gong Labs (304K emails): the **interest CTA** ("Worth a look?") is the
  top cold-email CTA, ~2× an open-ended meeting ask. Meeting asks only win after
  engagement — hence reply-word CTAs in emails 1–2, nothing heavier in email 3.
- **Links/attachments:** zero links in touch 1 (spam-weighted, especially on young
  domains); attachments trigger phishing heuristics — never in cold. Proof travels
  on reply. (Removing tracking pixels alone improves placement 8–12% — lemlist;
  the platform already sends pixel-free.)
- **Personalization:** first-name merge alone ≈ no lift; **company-level concrete
  observations ~2× replies** (Woodpecker 17–18% vs 7–9%; Hunter +52% for depth
  beyond merge tags; "numbers hook" openers 8.6% reply / 62% positive vs 4.4%
  baseline — Digital Bloom). The pre-run scan result is exactly this hook.
- **Generic inboxes (info@):** no published study isolates owner-read micro-SMB
  info@; broad-B2B data says role addresses engage worse and recycled ones become
  spam traps — **MV pre-send verification is the prescribed mitigation** (already
  in the pipeline). Best practice: greet by business name / owner-role ("for
  whoever runs {{company}}"), and **give info@ sends their own mailbox pool** so
  their engagement profile can't drag down the personal-email pool.
- **LinkedIn:** acceptance favors **blank connect requests** (Belkins 15.1M: 27.6%
  blank vs 25.3% noted; Botdog 16.5K: +80% blank), while noted requests pre-qualify
  (post-connect reply 8.2% vs 5.3%) — but template saturation dropped noted-request
  replies 37% in the last year (Reachium). Verdict: **send blank, spend the
  personalization in message 1 after acceptance, reference the email thread.**
  LinkedIn messages ~10.3% response vs ~5.1% cold email (Expandi); multichannel
  lift 2–3× (vendor-published, directional). Note limit if ever used: 300 chars.
- **Timing:** Tue–Thu, 8–11am recipient-local (WarmySender 75K: Tue 9–11am = 4.8%
  reply); founder data favors early morning — owners triage mail before customers
  arrive. Start enrollments Tuesday morning.
- **Compliance:** CAN-SPAM applies to B2B: truthful headers, **a valid physical
  postal address in every email**, and a functional opt-out honored within 10
  business days. **A reply-based opt-out satisfies the law — no unsubscribe link
  required** (FTC guidance) — which validates the platform's deliberate no-link
  stance, *provided* every email carries the address + one opt-out sentence.
  LinkedIn automation: ToS §8.2 risk is behavioral (velocity, low acceptance,
  repetitive templates; one 50-account test: 23% restriction within 90 days) —
  our 80/week cap is under the ~100 community ceiling; halt connects if
  acceptance <25%; residual risk is non-zero and is the client's own account.

## 3. Positioning language for this audience

**Zero acronyms in copy.** Search-demand data (Rankability, State of AI Search 2026)
shows GEO/AEO query volume is ~3 orders of magnitude below "SEO" and plateaued —
they're insider terms. Buyers say "ChatGPT," "Google AI," "AI search." Rule for this
sequence: describe the behavior, not the category — *"when someone asks ChatGPT for
a med spa in Frisco, it recommends someone. Right now it isn't you."* If a label is
unavoidable, "AI visibility" is the most buyer-legible (Contently Apr 2026, Forbes
Aug 2026 both document the unsettled vocabulary). Save "GEO" for the pricing page
and agency-facing material.

**Tone guard:** inboxes are already seeing generic GEO spam ("a cottage industry of
vendors"). The differentiation is evidence — a named competitor, a real question, a
checkable claim — and loss aversion tied to revenue units owners feel (calls,
bookings, jobs going to a named rival), never "citations"/"prompts"/doom. Also never
overclaim: don't cite Gartner's debunked "search drops 25%" stat, don't promise
conversion multipliers, don't say "SEO is dead" (§2.4).

## 4. Sorting framework — who gets which track

Two sort axes decide the campaign a contact lands in, plus the A/B coin flip.

### Axis 1 — channel (decides the LinkedIn fork)
| Cohort | Signal in CRM | Track |
|---|---|---|
| **LI cohort** | has LinkedIn profile (LinkedIn-vein sourced, or enriched with a profile URL) | Email sequence **+ LinkedIn fork** (§7) |
| **Named email-only** | first/last name known (Maps vein + naming phase, pattern_mv verified email) | Email sequence, named greeting |
| **Generic inbox** | `info@`/`contact@` scraped from Maps, no person name | Email sequence, company-addressed greeting |

### Axis 2 — scan outcome (decides the per-contact data lines)
Pre-running the scan buckets every prospect; the bucket writes the contact's
`fix_line` custom field (one CSV column — campaigns stay identical):

| Bucket | Scan result | `fix_line` content (email 2 middle line — **fully rendered at CSV build time**; a custom-field value is inserted verbatim, nested `{{tokens}}` inside it would NOT resolve) |
|---|---|---|
| **GAP** (default) | site readable, brand not mentioned, competitors named | DR comparison, e.g.: "your site's authority score is 12 out of 100 — the sites ChatGPT actually cites for this search score far higher. That gap is fixable." |
| **BLOCKED** | AI Readiness fail (robots.txt blocks GPTBot, JS rendering, no schema) | e.g.: "your site is currently unreadable to AI crawlers — ChatGPT literally can't read it. That's usually a 20-minute fix." |
| **CITED** | brand already mentioned/cited | Park for launch. (Weakest cold angle; a later "defend your position" track can pick these up.) |

- CITED prospects are **excluded from the launch batch** — the gut-punch is the
  campaign. Keep them in a holding segment.
- BLOCKED is the easiest sell in the list (a concrete, checkable defect).

### Axis 3 — angle assignment (A/B/C/D)
> **Superseded by §0 — read that first.** The Flow builder DOES support in-campaign
> A/B/C/D email variants, so the four angles are variants on ONE email-1 node (an
> automatic 25/25/25/25 split), not separate campaigns. No mod-4 CSV rotation needed.
> The matrix below stands only as the fallback if you ever need per-angle *email-2*
> coherence (that alone requires separate campaigns).

Rotate rows at CSV build time (row mod 4 → angle A/B/C/D) within each cohort, so the
split is 25/25/25/25 *per cohort*. ~~The platform has no in-campaign variants, so each
angle is its own campaign~~ (see §0).

**Launch matrix — 8 email campaigns + 1 LinkedIn sequence:**

| Campaign | Cohort | Angle |
|---|---|---|
| `TuBe Launch — Named — A (mention gap)` | LI cohort + named email-only | A |
| `TuBe Launch — Named — B (market shift)` | LI cohort + named email-only | B |
| `TuBe Launch — Named — C (found a problem)` | LI cohort + named email-only | C |
| `TuBe Launch — Named — D (mini-report)` | LI cohort + named email-only | D |
| `TuBe Launch — Generic — A/B/C/D` (4 campaigns) | generic inbox | A–D |
| `TuBe Launch — LinkedIn fork` | LI cohort only (parallel) | — |

**Judge angles on cohorts pooled** (A-Named + A-Generic vs B-pooled, etc.) — the
per-cohort split exists for mailbox pooling and greeting copy, not for doubling the
sample-size requirement. If batch volume is tight, launch all four angles and kill
the bottom two at ~100 delivered each, reallocating the remaining rows to the top
two (bandit-lite; §9).

## 5. The email sequences

### Merge data every contact must carry (CSV → `custom_fields`)

| Column / token | Content | Example |
|---|---|---|
| `{{buyer_question}}` | the exact question the scan asked, no quotes | best med spa near Frisco TX |
| `{{competitors}}` | pre-joined competitor string ("X and Y", or just "X") | Radiance Med Spa and Glow Aesthetics |
| `{{competitor_1}}` | first competitor alone (email 3 + LinkedIn) | Radiance Med Spa |
| `{{city}}` | city | Frisco |
| `{{dr}}` | Domain Rating integer — optional; by default baked into `fix_line` at CSV build (nested tokens inside a field value don't resolve) | 12 |
| `{{fix_line}}` | bucket-specific sentence (§4 axis 2), **fully pre-rendered text** | full sentence |
| standard | `{{first_name}}`, `{{company}}`, `{{your_name}}` | resolved by the platform |

**Hard rule: no empty cells.** An unknown/blank token ships literally as
`{{token}}` in the sent email (the platform leaves unmatched tokens untouched, and a
null custom value is skipped from the map). Filter the sheet for blanks before import;
the builder's preview + import token check will also surface them.

**Spintax rules:** `{option a|option b}` single-brace with pipes, nesting allowed,
deterministic per recipient. Keep `{{tokens}}` **outside** spin groups (the engine
warns on tokens inside spintax). Subjects stay fixed per angle (no spintax) — the
subject travels with its angle as one package; subject + email 1 together are the
unit under test.

Timing: step 0 sends on enrollment; steps 1 and 2 each have `wait_days: 3` → days
0 / 3 / 6 (weekend sends slide to Monday — the window is Mon–Fri business hours).
Follow-ups leave `subject_template` empty → they thread as "Re:" on the same thread,
which is deliberate: the bump re-surfaces email 1. Stop-on-reply is automatic.

---

### Signature block — appended to every email, all angles

CAN-SPAM requires the postal address in each email; the opt-out sentence doubles as
the legal mechanism and a spam-button diverter:

```text
{{your_name}}
TuBe SEO
[postal address — pending sending-identity decision, §10]

P.S. Not for you? Reply "no thanks" and that's the last you'll hear from me.
```

*(Put the P.S. line in emails 1–2; email 3's body already carries its own exit line,
so there it's just name + address.)*

*Generic-inbox greeting swap — all angles (replace line 1 of email 1; body
unchanged):*

```text
{Hi —|Hello —} {this is for whoever runs|quick one for whoever handles} marketing at {{company}}.
```

---

### The four angles (rev 2026-08-26 — replaces the two-arm placement test)

Owner call: instead of testing *where* the offer lands, **all four arms offer the
report in email 1** (the §2.3 evidence — lead with the finding — favored that
anyway; placement can be re-tested inside the winning angle later). What varies is
**the door we knock on**: which motivation opens the conversation. Each angle is its
own subject + email 1 + email 2; **email 3 is shared**. Every arm uses the same
pre-run scan data and the same merge columns — no new CSV work.

**Coherence rule:** each email 2 delivers the evidence its email 1 *didn't* use, so
every prospect eventually sees the full payload — competitor gap + market stat +
fix — just in a different order. The opening frame is genuinely the only variable.

| Angle | Frame | Email 1 leads with | Subject (fixed, memo-style) |
|---|---|---|---|
| **A — Mention Gap** | competitor loss | who ChatGPT names instead of them | `{{company}} on chatgpt` |
| **B — Market shift** | urgency / where buyers went | the 6% → 45% stat | `how {{city}} customers search now` |
| **C — Found a problem** | concrete defect on *their* site | their `fix_line` | `found this on {{company}}'s site` |
| **D — Mini-report** | give-first proof | the report itself, quoted in the email | `report for {{company}}` |

---

#### Angle A — Mention Gap (competitor loss)

**Email 1 — day 0:**

```text
{Hi {{first_name}} —|Hey {{first_name}} —|{{first_name}} —}

{I asked|So I asked} ChatGPT "{{buyer_question}}" — {the way more and more of your customers now search|which is how a growing share of your customers now search}. It {recommended|named} {{competitors}}. {{company}} {didn't come up|wasn't mentioned}.

{We built|I run} a scanner that checks this across ChatGPT, Gemini, Perplexity and Google's AI results — and shows {exactly why you're being skipped|what's blocking you} and how to fix it. I already ran {{company}}'s report. {Happy to send it over|Yours if you want it} — no charge, nothing to sign up for.

{Worth a look? Just reply "send it".|Want it? Reply "send it" and it's yours.}

{{your_name}}
```

**Email 2 — day 3** (threads as Re:) — delivers fix + stat:

```text
{Quick follow-up|Following up} — one more thing the scan flagged: {{fix_line}}

{Until that's addressed|Until then}, AI tools will keep sending people to {{competitors}} {by default|instead}.

{For context:|Why it matters:} a year ago, 6% of consumers asked AI tools for local business recommendations. {This year it's 45%|Now it's 45%} (BrightLocal's 2026 survey). {That shift only goes one direction.|Those people never see page one.}

The report's {still here|ready} — reply {"send it"|with a word} and it's yours.

{{your_name}}
```

#### Angle B — Market shift (urgency; competitor names held for email 2)

**Email 1 — day 0:**

```text
{Hi {{first_name}} —|Hey {{first_name}} —|{{first_name}} —}

{A number that stopped me this week:|One number worth your time:} a year ago, 6% of people asked AI tools like ChatGPT for local business recommendations. {This year it's 45%|Now it's 45%} (BrightLocal's 2026 survey).

{So I checked your market.|So I checked {{city}}.} {I asked|We asked} ChatGPT "{{buyer_question}}" — it answered with specific business names, and {{company}} {wasn't one of them|didn't come up}.

{I ran|We put together} a full report on where {{company}} stands and what to fix — already done, no charge. {Reply "send it" and it's yours.|Want it? Reply "send it".}

{{your_name}}
```

**Email 2 — day 3** (threads as Re:) — delivers competitors + fix:

```text
{Following up|Quick follow-up} — I {dug one level deeper|pulled the detail} on that check. When I asked "{{buyer_question}}", the names that came back were {{competitors}}. Not {{company}}.

{The report also flags why:|And there's a why:} {{fix_line}}

{It's all in the report — reply "send it" and it's yours.|The full report's ready — one word and it's yours.}

{{your_name}}
```

#### Angle C — Found a problem (concrete defect; strongest for the BLOCKED bucket)

**Email 1 — day 0:**

```text
{Hi {{first_name}} —|Hey {{first_name}} —|{{first_name}} —}

{Ran {{company}}'s site through our scanner this week and one finding stood out:|I ran a scan on {{company}}'s site and found something you'd want to know:} {{fix_line}}

{That's a big part of why|That's usually why} AI tools like ChatGPT {skip you|pass you over} when customers ask for recommendations — and it's {fixable|a fixable thing} once you can see it.

The full report shows {exactly what to change|the exact fixes}, no charge. {Reply "send it" and I'll send it over.|Want it? Reply "send it".}

{{your_name}}
```

**Email 2 — day 3** (threads as Re:) — delivers competitors + stat:

```text
{Quick follow-up|Following up} — the reason that issue matters more than it looks: {I asked|we asked} ChatGPT "{{buyer_question}}" and it recommended {{competitors}}. {{company}} {wasn't named|didn't come up}.

{And that channel is growing fast:|Context:} 45% of consumers asked AI tools for local recommendations this past year — a year earlier it was 6% (BrightLocal).

The report's {ready|still here} — reply {"send it"|with a word} and it's yours.

{{your_name}}
```

#### Angle D — Mini-report (give-first; maximum value demonstration)

**Email 1 — day 0:**

```text
{Hi {{first_name}} —|Hey {{first_name}} —|{{first_name}} —}

{I ran {{company}} through our AI-visibility scanner.|We ran a full AI-visibility scan on {{company}}.} Two lines from your report:

1. {I asked|It asked} ChatGPT "{{buyer_question}}" — it recommended {{competitors}}. {{company}} wasn't named.
2. {{fix_line}}

The full report has {the rest — where you stand across the major AI assistants, plus the exact fixes|the complete picture and the fixes}, in plain English. {It's yours, no charge — reply "send it".|No charge, nothing to sign up for — reply "send it" and it's yours.}

{{your_name}}
```

**Email 2 — day 3** (threads as Re:) — delivers stat + what else is inside:

```text
{Following up|Quick follow-up} — the report's {still sitting here|still yours if you want it}. Beyond those two findings, it {shows|covers} where {{company}} stands on every major AI assistant, which competitors keep coming up, and the fixes in priority order.

{For context:|Worth knowing:} 45% of consumers asked AI tools for local recommendations this past year, up from 6% the year before (BrightLocal).

{One word — "send it" — and it's in your inbox.|Reply "send it" and it's in your inbox.}

{{your_name}}
```

---

#### Email 3 — day 6, shared by all four angles (threads as Re:)

The breakup now also opens the second door in the funnel — the site's **free
30-minute review** — phrased with the site's own disarming stance ("no pitch, you
keep the findings"). Shared across angles, so it can't pollute the test:

```text
{Closing the loop on this.|Last note from me on this.} If AI search isn't on your radar yet, {totally fine|no problem} — honestly, you're still early.

{One thing I'd leave you with:|Just one parting thought:} when your next customer asks ChatGPT instead of Google, whoever it names first gets the call. {Right now|Today} that's {{competitor_1}}.

If you ever want the report, it's a one-word reply away. {Prefer to talk it through instead? We also do a free 30-minute review — no pitch, and you keep everything we find.|If you'd rather talk it through, we do a free 30-minute review — no pitch, you keep the findings either way.} {Otherwise, I won't follow up again.|Either way, this is my last email.}

{{your_name}}
```

---

### What the A/B/C/D actually measures

Four doors into the same house: every arm carries the same evidence and the same
CTA ("send it"), in a different order behind a different opening frame. The read is
which **motivation** moves this ICP — rivalry (A), urgency (B), a concrete defect
on their own site (C), or delivered proof (D). §2 predicts A and D lead: loss
aversion and audit-led evidence are the two best-documented patterns, and D is the
purest execution of "demonstrate the value" — it doesn't describe the report, it
quotes it. But D is untested at this brevity, C may win the BLOCKED bucket
outright, and B is the safest claim if the gut-punch ever feels too aggressive for
a niche. Decision rule in §9. (The old offer-placement question folds in: every
arm leads with the offer; re-test placement within the winning angle later if it
still matters.)

## 6. LinkedIn fork (LI cohort, parallel campaign)

Runs as its own campaign on the sequence engine (kinds `connect_request` → `message`),
per-account caps 80 connects/week + 150 messages/day, dispatched by the 15-min cron.
**Gated on Unipile activation** — checklist in `RESUME-LINKEDIN-CHANNEL.md`. Copy and
campaign are built now; the switch flips later.

**Connect requests go out BLANK** — the acceptance data favors no note (27.6% vs
25.3% blank-vs-noted at 15.1M touchpoints; +80% in Botdog's study), template-note
fatigue is measured and worsening, and blank protects the 80/week cap's yield. The
personalization is spent in message 1, which references the email thread —
cross-channel recognition is the multichannel mechanism.

| Day | Touch | Copy |
|---|---|---|
| 2 | `connect_request` | *(blank — no note)* |
| ~4 (post-accept, `wait_days: 2`) | `message` 1 | `Thanks for connecting, {{first_name}} — I'm the one who emailed you about {{company}} and ChatGPT. Short version: I asked it "{{buyer_question}}" and it named {{competitor_1}}, not you. Already ran {{company}}'s full report — want me to send it over here?` |
| ~8 (`wait_days: 4`) | `message` 2 | `No worries if this isn't a priority — closing the loop. The report checks ChatGPT, Gemini, Perplexity and Google's AI answers, grades your site, and names who's winning your searches right now. One word and it's yours.` |

Interleave with email: Email 1 (D0) → connect, blank (D2) → Email 2 (D3) → LI
message 1 (~D4, only after accept) → Email 3 (D6) → LI message 2 (~D8). (A
`profile_visit` "free touch" on D1 is a reserved step kind in the engine — not in
v0; worth enabling later.)

**Safety:** 80 connects/week stays under the ~100/week community-tested ceiling;
**pause connects if acceptance drops below 25%** (that's LinkedIn's behavioral
restriction trigger — one 50-account test saw 23% restrictions within 90 days of
sloppy automation). The account at risk is the real company account; treat the cap
as a floor of caution, not a target.

**Cross-channel stop is manual for now:** a reply on one channel auto-stops that
campaign's enrollment only. Ops note: when a hot reply lands, pause the contact's
enrollment on the other channel from the campaign screen. (Small code follow-up
candidate: auto-pause sibling enrollments for the same contact on reply.)

**Verify at activation:** that the engine holds `message` steps until the
connect request is accepted (expected behavior; confirm on the first live cohort).

## 7. Running it in LeadStart — exact steps

1. **Build the batch.** Pull the target list (Maps vein niches + LinkedIn-vein
   names). Pre-run TuBe scans (batch; $0.034 × N). Generate the CSV per cohort with
   the §5 token columns; blank-check every column; rotate rows mod-4 into the four
   angle files per cohort.
2. **Create the 8 campaigns** (§4 matrix) in the native builder. 3 email steps each:
   step 0 with the angle's subject, steps 1–2 with `wait_days: 3` and empty subject
   (threads as Re:). Paste the angle's copy verbatim — spintax renders per recipient
   deterministically; preview with a real contact to confirm tokens resolve.
3. **Import each CSV** into its campaign (client-import maps columns → custom
   fields; the token check will list required columns from the pasted templates).
4. **Mailbox capacity + pooling.** The ramp is 5 → +1/day → 20 sends/mailbox/day,
   Mon–Fri. Steady state, a 3-step sequence supports roughly **7–8 new prospects
   per mailbox per day** (20 ÷ ~2.6 average sends per enrolled contact after
   reply/bounce attrition). Four warmed mailboxes ≈ ~30 new prospects/day ≈
   ~600/month across all campaigns. **Four-angle batch math:** a clean read needs
   ~800–1,000 prospects (≥150–200 delivered per angle, cohorts pooled) — that's
   ~$34 of scans, and roughly **5–6 weeks on 4 warmed mailboxes or ~2½–3 weeks on
   8**. Recommendation: warm 8 mailboxes (or accept the longer window; the
   bandit-lite kill rule in §9 shortens it). During warmup, throttle imports with
   the per-campaign daily-new-leads cap. **Pool separation (§2.5): give the Generic
   (info@) campaigns their own mailboxes** — role-address engagement profiles run
   worse and shouldn't share reputation with the personal-email pool. Start
   enrollments **Tuesday morning** (Tue–Thu 8–11am local is the measured peak).
5. **Scan cost at that volume:** 600 prospects/month ≈ **$20/month** of scans.
6. **Replies:** the reply pipeline classifies them; "send it" replies surface as
   hot leads. Fulfillment: send the pre-run report (manual on day 1; see open item
   about a tokenized report link in §10).

## 8. Compliance + deliverability notes

- **No unsubscribe link / headers** — deliberate platform stance for low-volume B2B
  (documented decision; do not add). **Research verdict (§2.5): a reply-based
  opt-out satisfies CAN-SPAM — no link required** — provided each email carries a
  clear opt-out sentence and suppression happens within 10 business days. The
  platform's reply-based DNC suppresses immediately, which more than clears the bar.
  The signature's "reply 'no thanks'" line is the clear-and-conspicuous mechanism.
- **Postal address is REQUIRED in every email** (CAN-SPAM, confirmed §2.5) — the
  signature block in §5 carries it. Blocked on the sending-identity decision (§10);
  do not launch without it.
- **Links:** none in emails 1–2 by design (deliverability + the reply-CTA is the
  whole motion). Email 3 stays link-free too in v1; the report itself travels on
  reply. The TuBe sender-identity doc's "first touch link-free" rule agrees.
- **Sending identity:** open decision (§10) — which domain/mailboxes send TuBe
  outreach. The TuBe outreach doc's pattern (brand-adjacent domain, 301 → real site,
  real person sender) is the default recommendation.
- Spam-word lint will run on paste; copy above avoids the classic triggers ("free"
  is phrased "no charge / costs nothing").

## 9. Measurement + decision rule

- **Primary metric:** scan-request rate = replies asking for the report ÷ delivered.
  (The classifier tags these positive; count from the inbox/hot-lead stream.)
- **Secondary:** total reply rate, negative/opt-out rate, bounce rate (pattern_mv/MV
  verification upstream should hold bounces <2%).
- **Judging the four angles:** pool cohorts per angle (A-Named + A-Generic vs
  B-pooled, …). **Bandit-lite:** at ~100 delivered per angle, kill the bottom two
  and reallocate remaining rows to the top two; final call at **≥150–200 delivered
  per surviving angle**. Expected ranges from §2 benchmarks: platform-average cold
  reply is ~3.4%, top quartile 5.5%+; audit-led personalized outreach documents
  6–15%; owner-operator micro-SMBs are the highest-replying segment. **Working
  targets: ≥5% total reply rate, ≥40% of replies positive (scan requests). Below 3%
  reply after 200 delivered = copy problem; below 25% positive share =
  offer/targeting problem.** The winning angle becomes the default; losers become
  re-engagement material. Read C separately for the BLOCKED bucket — it may win
  there while losing overall.
- **Down-funnel (the metric that pays):** reports fulfilled → **free 30-minute
  reviews booked** → engagements signed. At $3,500/mo (≈$42K/yr), one client per
  ~2,000 cold emails is already a strong campaign — don't over-optimize reply rate
  at the expense of reply *quality*. Track reviews booked per angle; a lower-reply
  angle that books more reviews wins.

## 10. Open items

**Daniel (decisions/credentials):**
- Sending identity for TuBe outreach: domain + mailboxes (brand-adjacent domain per
  the TuBe sender doc?), and the **postal-address line for signatures — a launch
  blocker per §8** (CAN-SPAM).
- Product: build the **ungated tokenized per-prospect report URL** for outbound
  fulfillment — upgraded from nice-to-have to evidence-backed (§2.3: cold
  recipients should get zero-friction results; the email-gate is for inbound).
  Until it exists, fulfillment on reply is manual.
- Pick launch niches/cities for batch 1 (Maps vein packs) + batch size (~800–1,000
  for a clean four-angle read), and which mailboxes form the Generic vs Named pools
  (§7.4) — 8 warmed mailboxes recommended for the 4-angle timeline.
- **Confirm the cold scan's engine list.** The site promises six assistants
  (ChatGPT, Claude, Perplexity, Gemini, AI Overviews, AI Mode); the scan cost log
  lists five (no Claude). Copy currently names engines without a count
  ("ChatGPT, Gemini, Perplexity and Google's AI results") — if the fulfillment
  report covers all six, the copy can and should say "all six," and the report
  must match what the site promises.
- LinkedIn channel activation when ready (RESUME-LINKEDIN-CHANNEL.md checklist).
- Greenlight to commit this doc (local-only right now).

**Claude (next sessions):**
- Batch scan pre-run + CSV generation script once batch 1 niches are picked
  (scan output → the §5 token columns, bucket sort, A/B row alternation).
- Optional: auto-pause sibling enrollments cross-channel on reply (§6).

**External / waiting:** none for the email arms; LinkedIn fork waits on Unipile
config.

---

## Appendix — key sources

Market/stats: Pew Research (Jul 2025) pewresearch.org · Ahrefs AIO CTR studies
(Apr 2025 / Dec 2025) ahrefs.com/blog/ai-overviews-reduce-clicks · Semrush AIO
study semrush.com/blog/semrush-ai-overviews-study · SparkToro/Datos zero-click 2026
via searchengineland.com · **BrightLocal Local Consumer Review Survey 2026**
brightlocal.com/research/local-consumer-review-survey (the 45%/6% stat) ·
Whitespark local AIO study (May 2025) whitespark.ca · Search Engine Land 13-month
LLM-traffic dataset · Gartner −25% debunk: searchenginejournal.com (never cite the
original). Competitor pricing: trakkr.ai, localfalcon.com/pricing, layer3labs.io
(Otterly), auditae.app (Semrush real cost), ewrdigital.com (Brand Radar).

GTM/free-scan: HubSpot Website Grader history (hubspot.com archives + teardowns) ·
Neil Patel 100K leads/mo (x.com/neilpatel) · SEOptimer agency white-label model ·
Unbounce single-field 23.4% · Outgrow interactive-form data · OpenView/ProfitWell
2.6% freemium median · ChartMogul trial data · Tannenbaum et al. 2015 fear-appeal
meta-analysis (Psychological Bulletin) · Outbrain negative-headline study via
poynter.org · audit-led reply bands: ClearAudit/AISO 2026 workflow data ·
Woodpecker 20M-email stats woodpecker.co/blog/cold-email-statistics.

Outbound mechanics: Instantly Cold Email Benchmark Report 2026 · Belkins 7.5M-email
response study + 15.1M-touchpoint LinkedIn study belkins.io · Gong Labs 304K-email
CTA study gong.io · Unify follow-up dataset 2026 · Smartlead 85M subject-line data ·
Digital Bloom hook benchmarks · Hunter.io State of Cold Email · lemlist pixel/image
data · Botdog + ReactIn + Reachium LinkedIn note studies · WarmySender 75K timing
study · Litemail/Vendisys CAN-SPAM guidance 2026 · ConnectSafely/PhantomBuster
LinkedIn automation risk 2026 · Growleady no-name greeting patterns.
