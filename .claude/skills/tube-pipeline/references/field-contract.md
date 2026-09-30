# Field contract: LeadStart ⇄ TuBe

What crosses each boundary, column by column. If TuBe's export or the campaign's copy changes, update this file and the scripts' column lists **together**:
- `OUTREACH_COLS` in `validate-export.mjs`;
- `FIELD_MAP` in `import-campaign.mts`.

## 1. Upload sheet: LeadStart → TuBe

`buildTubeHandoff` builds it (`src/lib/tube/handoff.ts`, the in-app "TuBe upload" code). `build-upload.mts` writes it as `sheet.csv` and `tube-upload-<run>.csv`. TuBe maps columns by header name, and `markets` must come before `city`.

| Column | Example | Meaning |
|---|---|---|
| domain | `hartwelllaw.example` | The firm's website host. TuBe's key for the firm, and the join key for everything after. |
| business_type | `personal injury lawyers` | The practice, as a customer would ask for it. |
| seed_query | `Who are the best personal injury lawyers in Seattle, WA?` | The exact question TuBe asks Google's AI, word for word. |
| markets | `Seattle, WA` | Locks the question's city. |
| company | `Hartwell Law Firm` | The short Google listing name. |
| first_name, last_name | `Maya`, `Hartwell` | The owner the email goes to. |
| email | `maya@…` | A verified personal email, or the owner's own address as published on the firm's site. |
| city, state | `Seattle`, `WA` | |
| aliases | `Hartwell Law Firm; Maya Hartwell` | Every name the firm goes by (listing, legal name, owner), so TuBe can recognise the firm in an AI answer. |

A firm reaches the sheet only when all of these hold:
- it has a website;
- it's a law firm when the list is mostly law;
- it passes the ICP exclusions (large firms, nonprofits, public bodies);
- it has an enriched contact with an owner first name;
- its email is verified, or is an owner address published on the firm's own site;
- it has a city and state;
- its practice area is specific (`--include-generic` opts in "lawyers"-only firms);
- its website isn't a duplicate of another firm's.

## 2. Export for outreach: TuBe → us

The TuBe admin page → a batch → **Export for outreach** produces `<uploaded file>-outreach.zip`, which holds:
- `outreach-send.csv`;
- `outreach-review.csv`: the same columns plus `review_reason`.

It comes from `runOutreach` in TuBe's `src/pages/admin/AdminDashboard.jsx`.

| Column | Meaning |
|---|---|
| email, first_name, company | From our sheet, as uploaded. |
| firm | The display name for copy (`displayName()`): no PLLC/P.S./"Attorney at Law", ALL CAPS recased, listing taglines cut. |
| city | The city as asked, without the state. |
| business_type | As asked. |
| competitor_1 | The **first** firm Google's AI named (answer order), display-cleaned. It is only set when TuBe confirmed that name verbatim in the answer. |
| competitors | The first two valid competitors, joined with " and ". |
| question | The question actually asked. It must equal our `seed_query`. |
| ai_rank | `N of M`. Only for NAMED_NOT_FIRST. |
| ahead_of_you | The firms named before the prospect, joined with "; ". Only for NAMED_NOT_FIRST. |
| domain_authority | 0–100: DataForSEO's domain rank ÷ 10. The copy calls it "website authority". It is **not** Ahrefs DR. |
| ai_visibility | 0–100. It averages Google AI Mode on the who's-best question with Perplexity on a different question, so copy must never call it "Google's score". |
| ai_verdict | cited / mentioned / not cited / … (informational). |
| segment | See below. |
| report_link | `https://tube-seo.vercel.app/api/prospect-report?id=<scan uuid>`. Public, and **never expires**. |
| subject, hook | TuBe's own draft copy. **Never imported**: the owner writes copy in the campaign template, and every per-prospect value goes in as its own field (owner rule, 2026-09-25). |
| domain, scanned_at | The join key, and when the scan ran. |

**Segments**
- Sendable, and in `outreach-send.csv` only when every check passed:
  - `NOT_NAMED`: Google's AI didn't name the firm.
  - `NAMED_NOT_FIRST`: named, but not first.
- Review only:
  - `NAMED_FIRST`: nothing to pitch.
  - `UNSCANNED`: the scan didn't finish.
  - `RESCAN`: an old scan with no positions.
  - `PROBE_FAILED`: Google didn't answer.
  - `NO_QUESTION`.
  - `NAMED_POSITION_UNKNOWN`.
  - Any sendable row whose stored Google answer contradicts the verdict. Its `review_reason` says why.

`validate-export.mjs` refuses any export missing one of these columns, because a missing column means TuBe changed the contract. Exports from before 2026-09-26 (TuBe `df28ada`) lack `firm`.

## 3. Into the campaign: us → LeadStart

`import-campaign.mts` matches each validated row to the **existing** LeadStart contact with that email. Every row came from LeadStart, so a row with no contact is skipped, never created. It then:
- sets `client_id` to the campaign's client (adopt), when the contact is still unassigned;
- sets `campaign_id` to the campaign;
- merges these keys into `contacts.custom_fields`, under the same names:

| custom_fields key | From export column | Who has it | Format |
|---|---|---|---|
| firm | firm | all | text |
| business_type | business_type | all | text |
| city | city | all | text |
| competitor_1 | competitor_1 | all | text |
| competitors | competitors | all | "A and B" |
| question | question | all | ends with "?" |
| ai_rank | ai_rank | NAMED_NOT_FIRST only | "N of M" |
| ahead_of_you | ahead_of_you | NAMED_NOT_FIRST only | "A; B" |
| segment | segment | all | NOT_NAMED / NAMED_NOT_FIRST |
| report_link | report_link | all | URL |
| ai_visibility | ai_visibility | all | "0"–"100" (text) |
| domain_authority | domain_authority | all | "0"–"100" (text) |

It also:
- inserts a `campaign_enrollments` row: `current_step_index 0`, `status active`, unique per campaign+contact, so a re-run enrolls nobody twice;
- reconciles `campaigns.variables`: the 12 keys are registered as the campaign's custom variables, the same way the app's CSV import registers mapped columns.

**Never touched:** `first_name`, `last_name`, `email`, `company_name`, tags, status, verification. The standard columns already came from LeadStart's enrichment.

**Skipped at import** (re-checked live, because days can pass between stages):
- email not a LeadStart contact;
- belongs to another client;
- bounced, unsubscribed or replied;
- verifier says undeliverable;
- on the do-not-contact list (org-wide or the campaign's client);
- pooled as a weak email host;
- already enrolled in this campaign;
- the same firm (website or non-Gmail email domain) already in this campaign;
- active or paused in another campaign;
- already emailed by LeadStart.

**What the copy uses.** Always read it live: `verify-campaign.mts` prints it. On 2026-09-29 the copy used:
- `{{first_name}}`, `{{firm}}`, `{{question}}`, `{{competitor_1}}`, `{{ai_visibility}}`, `{{domain_authority}}`;
- `{{signature}}`, the sending inbox's own signature. The contact doesn't supply it.

If the owner adds `{{ai_rank}}` or `{{ahead_of_you}}` to copy that NOT_NAMED contacts also receive, those emails would print a blank. The render check catches that and refuses the import; tell the owner rather than working around it.

## 4. Where the ground truth lives

- **The firm's report page** (`report_link`) shows:
  - the questions asked;
  - the verdict per question ("You never came up" / "Named #N of M");
  - the AI's recommended firms in answer order, without the prospect, up to 6;
  - a ~520-character excerpt of the answer;
  - the two 0–100 scores.
- **TuBe's database** (`prospect_scans.metrics`) keeps a 3,000-character answer excerpt. TuBe's export check reads that; the report page can't show it.
- **Reports are generated once, at scan time.** A later TuBe code change reaches only new scans and re-runs.
