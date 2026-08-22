# Memory index

- [Local-only dev default](feedback_local_only_dev.md) — never push or commit on LeadStart without explicit approval; master auto-deploys to prod
- [No AI drafting in reply-routing](feedback_no_ai_drafting.md) — Claude is for classification only; no Sonnet drafter, no pre-fill on the portal composer
- [LinkedIn parallel-channel motivation](project_linkedin_parallel_channel_motivation.md) — Unipile is the LinkedIn channel; Salesforge LinkedIn pricing is the reason we keep our own cadence
- [Contact status source of truth](project_contact_status_source_of_truth.md) — contacts.status is the dispatched-yet signal; salesforge_contact_id ≠ "pushed"
- [No warmup pool is deliberate](project_no_warmup_pool_deliberate.md) — the 5→+1/day→20 ramp + inbox-health monitoring replaces warmup pools on purpose; do NOT add unsub headers/links (verified inapplicable + harmful for low-vol B2B); real gaps are pre-send verification then Postmaster
- [Dev server .next/OneDrive gotcha](project_dev_server_next_cache_onedrive.md) — "Can't resolve tailwindcss" from the parent dir = stale .next cache; wipe .next & restart (not a turbopack.root issue); watch for leaked postcss workers
- [Dev auto-login route](project_dev_autologin_route.md) — hit /app/api/dev/login to auth the local preview (dev-only, no password); configured to DEV_AUTOLOGIN_EMAIL in .env.local
- [Seed placement tests + the 2026-08-20 health dip](project_seed_placement_tests.md) — the dip was the stricter scoring model (DMARC p=none + zero-reply signal), not degradation; seed inboxes/placement tests (migration 00068) are the direct measurement; probes never touch native_sends, seeds are read-only
