---
name: mv-credit-cost-basis
description: "MV credit costs use the 10K-bundle rate $0.0037/credit (owner call 2026-08-25); never quote hardcoded cost constants as fact — verify against the provider's tiered pricing first"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b051d5a7-63b7-4f50-9efc-c32759ea5823
  modified: 2026-08-25T23:18:53.379Z
---

Million Verifier credits are prepaid and TIERED ($37/10K ≈ $0.0037 … ~$549/1M ≈ $0.0005 — verified 2026-08-25). The repo's old `MV_CREDIT_COST_USD = 0.0007` was an unverified guess at the 500K rate; the owner caught me quoting it as fact ("You've been wrong on your math before. Verify.").

**Why:** cost figures drive routing decisions (pattern_mv vs scrape vs bovi) and will feed a client-facing tokenized pricing layer, so the internal basis must be honest. A single per-credit figure is only valid relative to the bundle actually purchased.

**How to apply:** owner call 2026-08-25 — assume the **10K bundle rate $0.0037/credit** in `MV_CREDIT_COST_USD` and all MV estimates until purchasing changes (pattern_mv: typ. $0.004–0.011/contact, ≤$0.022 worst; verify/pre-send: ≈$0.0037). End users won't see raw costs — a tokenization/markup layer is planned; internal numbers stay truthful. Before quoting ANY provider cost, check whether it's a verified rate or a hardcoded constant, and say which.
