---
name: preview-pane-raf-hydration
description: Hidden Browser-pane never fires requestAnimationFrame — deep-route full loads stall on the loading skeleton in dev; not an app bug; verify via client-side nav or real Chrome
metadata: 
  node_type: memory
  type: project
  originSessionId: 49c5cf66-5190-42f5-b924-a7fdcea8feb5
  modified: 2026-08-24T19:52:50.683Z
---

In the embedded Browser pane, when the pane is not displayed on screen the page
never composites, so `requestAnimationFrame` NEVER fires (setTimeout /
MessageChannel / requestIdleCallback still do; `document.visibilityState` stays
"hidden" even after fronting the tab, and spoofing it does not help). Under
Turbopack dev (Next 16.2.1), hydration of routes ≥3 segments deep whose chunk
graph pulls shared UI modules (e.g. `@/components/ui/card` — merely IMPORTING it
triggers this; PageHeader alone does not) parks a continuation on rAF → the page
sits on the parent segment's loading.tsx skeleton forever (`main.innerText`
empty, `.animate-pulse` present, zero console errors, SSR HTML complete).

Diagnosed 2026-08-24 after it was mistaken for a pre-existing app bug on
/app/admin/settings/api (also "hung": /admin/settings/team,
/admin/clients/[id]; fine: /admin, /admin/clients, /admin/contacts, trivial
depth-3 pages). The SAME direct-URL load renders perfectly in real Chrome.

**Why:** the stall is environmental (never-compositing renderer), not code. A
real user's browser composites whenever they look at the tab, so hydration
always completes.

**How to apply:** when verifying deep admin routes in the preview pane, use
client-side navigation (click sidebar links from /app/admin) instead of direct
URL loads — or test in real Chrome via claude-in-chrome. Do NOT file or chase
"page hangs on refresh" bugs reproduced only in the hidden pane; check rAF
liveness first (`requestAnimationFrame(() => ...)` never firing = this
artifact). Related: [[dev-server-next-cache-onedrive]].
