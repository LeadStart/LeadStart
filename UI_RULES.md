# LeadStart — UI rules (flat contract)

> The design contract every surface is swept to (see `/style-sweep`). Locked with Daniel 2026-08-22. When this file and a component disagree, this file wins.

## Locked rulings (2026-08-22)

| Ruling | Decision |
|---|---|
| **Font** | Keep **Poppins** (body + headings). No font swap. |
| **Sidebar** | **Brand gradient** — white logo header → deep brand-blue → navy (the one sanctioned decorative gradient; approved by Daniel 2026-08-22). Logo `h-[120px]` on the white top; light text + solid brand active pill over the dark lower panel; `border-r border-slate-200`. |
| **Dark mode** | **Deferred.** Ship light-only. The `hex→token` cleanup is therefore NOT mandatory this sweep (do it opportunistically). Revisit dark as its own pass. |
| **Badges** | **Solid fill** — semantic-500 background + white text, no gradient, no glow, no shadow. The six `badge-*` class names stay (lib code returns them as data). |
| **Control height** | 36px default (shadcn `h-9`) where a control is standalone; existing `h-8` buttons are acceptable — don't churn every button to change height. |
| **Charts** | Flatten Recharts gradient area fills to **solid low-alpha** (`fillOpacity ~0.08`); soften heavy tooltip shadows. Keep the color-coded KPI health tints (product signal). |

## The doctrine

Depth comes from a **1px hairline border + a surface tint**, never gradients, glows, or stacked shadows. **One shadow tier**, reserved for overlays (Dialog/Popover/DropdownMenu/Toast) — flat surfaces carry a hairline, not a shadow. 4px spacing grid (Tailwind default). Radius **8px controls / 12px cards / full badges** (`--radius: 0.5rem`).

## Tokens (defined in `src/app/globals.css` `:root`)

`--primary` stays LeadStart blue `#2E37FE`. Neutrals are slate (`--background #f8fafc`, `--card #fff`, `--muted #f1f5f9`, `--border #e2e8f0`, `--foreground #0f172a`, `--muted-foreground #64748b`). Sidebar is its own dark scale (`--sidebar #0f172a`, `--sidebar-foreground #cbd5e1`, `--sidebar-primary #2E37FE`, `--sidebar-primary-foreground #fff`, `--sidebar-border #1e293b`). `--radius: 0.5rem`.

## What "flat" forbids (each is a debt-grep in `STYLE_SWEEP.md` → target 0)

- Decorative gradients anywhere (backgrounds, buttons, badges, hero, table headers, login). Exemptions: functional gradients (CSS mask tricks) and the **sidebar's brand gradient** (a deliberate exception — see Component targets).
- Colored / multi-layer / inset box-shadows on surfaces; `filter: drop-shadow` glows; neumorphic stacks; page aurora/orbs; glass `backdrop-filter`.
- `!important` override blocks keyed on `data-slot` — style the primitive directly instead.
- Inline `#hex` chips and `bg-[#hex]` arbitraries — use `bg-primary` / token classes. (Deferred-cleanup while dark mode is out of scope, but new code must use tokens.)
- More than one shadow tier.

## Component targets

- **Card** (`ui/card.tsx`): `rounded-xl border bg-card`, no shadow, no gradient. CardTitle is normal-size (`text-base font-medium`) — the old 11px uppercase override is gone.
- **Button** (`ui/button.tsx`): `default` = solid `bg-primary text-primary-foreground hover:bg-primary/90`; `secondary` = `border bg-background hover:bg-muted`; one radius (`rounded-lg` = 8px) across variants. Legacy `.btn-gold`/`.btn-dark` classes are kept as **flat** aliases for straggler call sites.
- **Badge**: solid `badge-{green|amber|red|blue|purple|slate}` = semantic-500 fill + white text. `green #059669 · amber #d97706 · red #dc2626 · blue #2E37FE · purple #7c3aed · slate #475569`.
- **Input/Textarea/Select** (`ui/input.tsx`): 1px `border-input`, `rounded-lg`, focus → ring; no gradient border. (Component default is already flat once the global override is removed.)
- **Table** (`ui/table.tsx`): header `border-b`, rows `border-b hover:bg-muted/50`, no gradient header, no zebra, no inset bevel; never wrap a table in a Card.
- **Sidebar** (`layout/sidebar.tsx`): **deliberate brand gradient** — the one sanctioned decorative gradient. The `<aside>` carries an inline `linear-gradient(180deg, #ffffff 0px, #ffffff 116px, #1e249e 205px, #131b63 52%, #0f172a 100%)` over `background-color:#0f172a`. The white top is the logo header (`h-[124px]`, logo `h-[120px]` — the dark-artwork PNG needs a light backdrop to read), easing into deep brand-blue → navy so the nav sits on dark ground: light text, `bg-white/10` hover, solid `bg-sidebar-primary` active pill. `border-r border-slate-200` (light — the dark `sidebar-border` read as a black seam against the white top). Gradient stays inline (Tailwind v4 utilities don't emit it). No cast-shadow, no notch.
- **Stat / KPI cards**: flat card (or solid 50-tint) + hairline; no gradient, no `hover:shadow-md`. KPI health tints (emerald/amber/red) stay.
- **Charts** (`charts/*`): solid fills at `fillOpacity ~0.08`, soft tooltip shadow.
- **Page header / hero**: one shared `layout/page-header.tsx` (eyebrow + title + subtitle + actions) replaces the inline gradient block formerly copy-pasted into ~28 files. **Detail pages**: keep the inline back-link `<Link>`, then `<PageHeader className="mt-3" title={…} actions={…} />`; render the status pill in `actions` as a solid `badge-{green|amber|slate}` (`active→green · paused→amber · else→slate` — the same mapping the campaigns list uses). Header action buttons use standard variants — primary/create = `default` (solid primary), secondary = `outline`; the old `bg-white/15` / `bg-white/40` panel-tuned overrides are gone. (Create buttons still carry a `Plus` icon — stripping the `+` affordance app-wide is a deferred, separate decision.)
- **Auth pages** (`(auth)/login · reset-password · update-password · accept-invite`): a single centered Card (`max-w-md`) with the logo above it, matching login. The old `lg:w-[58%]` split panel with its decorative gradient + orbs (and the mask-gradient it needed) is removed. Auth cards keep `shadow-lg` as the one deliberate non-overlay shadow — a standalone entry card, consistent across all four.
- **StageFlowCard** (`admin/campaigns/[id]/stage-flow-card.tsx`): CompletionBanner is a solid `#2E37FE` block (no gradient, no drop shadow); TermBadge pills use solid semantic fills (`green #059669 · blue #2E37FE · red #dc2626`) with no colored shadow; the timeline connector is a solid `#CBD5E1` line; the step-number badge keeps its solid `#EA4335` fill but drops its colored glow.
- **Quote letterhead** (`components/billing/quote-layout.tsx`): solid `#EDEEFF` tint + hairline, no gradient.

## Interaction rules (carry these; they cost nothing)

No Card wrapper around a table or stat grid; filled-by-role button pairs; no `+` prefix on create buttons; toasts only on explicit save; 25/page URL-backed pagination; whole-row click-through on lists; inline back-arrow on detail headers; omit fabricated trend arrows when there's no prior-period series.

## Change log

- **2026-08-22** — Flat contract established; rulings locked (Poppins, dark sidebar, dark-mode deferred, solid badges). Foundation swept: `globals.css` + card/button/badge/input/table/sidebar/topbar/stat-card/kpi-card/daily-chart. Route pages + cross-cut hex debt tracked in `STYLE_SWEEP.md`.
- **2026-08-22 (rollout)** — Hero-band → PageHeader rollout completed across all ~24 dashboard route surfaces + the 6 detail headers; auth pages unified to a centered card (split-panel + decorative gradient removed); StageFlowCard + quote-layout bespoke gradients flattened. **App-shell decorative-gradient debt = 0** — every remaining `linear-gradient` hit is in email templates (`lib/email`, `api/*/route.ts`, notifications) or the disabled site-chat widget, both out of scope for this sweep. Detail-header, header-button, auth-card, and bespoke rulings recorded in Component targets above.
- **2026-08-22 (sidebar)** — Sidebar moved from flat-dark back to a **deliberate brand gradient**: white logo header → brand-blue (`#1e249e`) → navy (`#0f172a`). Logo enlarged 50% to `h-[120px]` on the white top so the dark-artwork logo reads clearly; nav density tightened (`h-[124px]` header, `pt-5`, `py-2`, `space-y-0.5`) to fit with no scrollbar; right border lightened to `slate-200` to kill the dark seam against the white top. Approved by Daniel — this is the one sanctioned decorative gradient and **supersedes the original "dark solid panel, gradient is gone" ruling**. (`sidebar.tsx` commit `30a0a7f`.)
