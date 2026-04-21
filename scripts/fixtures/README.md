# Webhook fixtures

Synthetic Instantly webhook payloads covering the full classification taxonomy.
Used by `scripts/test-reply-pipeline.mjs` (prefilter + ingest + reply-build
roundtrip) and later by commit #6's webhook handler tests.

Every fixture carries a stable `eaccount` (`mike-outreach@cabrera-alias.pro`)
and a stable `instantly_email_id` so the eaccount roundtrip assertions can
identify the same logical email across ingest → store → send.

| File | event_type | Expected `final_class` (after full classifier) |
|---|---|---|
| `webhook-lead-interested.json` | `lead_interested` | `true_interest` |
| `webhook-lead-wrong-person-referral.json` | `lead_interested` (misclassified!) | `referral_forward` (prefilter overrides) |
| `webhook-lead-wrong-person-no-referral.json` | `lead_wrong_person` | `wrong_person_no_referral` |
| `webhook-lead-ooo.json` | `lead_out_of_office` | `ooo` |
| `webhook-lead-unsubscribed.json` | `lead_unsubscribed` | `unsubscribe` |
| `webhook-reply-received-generic.json` | `reply_received` (no tag yet) | depends on Claude (commit #4) |

## Field-shape note

Real Instantly webhook bodies mix a few top-level fields with a sparse lead
record. The canonical source of truth for the reply envelope is the
`GET /api/v2/emails/{id}` response (41 fields including `eaccount`), which
the webhook handler will fetch during ingest. The fixtures pre-populate the
fields we know Instantly always gives us — anything else gets enriched
post-webhook.

See: [https://developer.instantly.ai/api-reference/email/get-email](https://developer.instantly.ai/api-reference/email/get-email)
