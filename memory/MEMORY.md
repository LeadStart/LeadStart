# Memory index

- [Local-only dev default](feedback_local_only_dev.md) — never push or commit on LeadStart without explicit approval; master auto-deploys to prod
- [No AI drafting in reply-routing](feedback_no_ai_drafting.md) — Claude is for classification only; no Sonnet drafter, no pre-fill on the portal composer
- [LinkedIn parallel-channel motivation](project_linkedin_parallel_channel_motivation.md) — Unipile is the LinkedIn channel; Salesforge LinkedIn pricing is the reason we keep our own cadence
- [Contact status source of truth](project_contact_status_source_of_truth.md) — contacts.status is the dispatched-yet signal; salesforge_contact_id ≠ "pushed"
- [No warmup pool is deliberate](project_no_warmup_pool_deliberate.md) — the 5→+1/day→20 ramp + inbox-health monitoring replaces warmup pools on purpose; do NOT add unsub headers/links (verified inapplicable + harmful for low-vol B2B); real gaps are pre-send verification then Postmaster
- [Dev server .next/OneDrive gotcha](project_dev_server_next_cache_onedrive.md) — "Can't resolve tailwindcss" from the parent dir = stale .next cache; wipe .next & restart (not a turbopack.root issue); watch for leaked postcss workers
