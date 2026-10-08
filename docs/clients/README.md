# Client ledgers

One central file per client: where its campaigns stand, which cities and regions have already been worked, what each prospecting run pulled, enrolled and cost, and what's planned next. **Check a client's ledger before planning any new prospecting for it.**

| Client | Ledger |
|---|---|
| SaaSassins | [saasassins.md](saasassins.md) |
| David Cabrera | [david-cabrera.md](david-cabrera.md) |
| Astro Jump Sonoma | [astro-jump-sonoma.md](astro-jump-sonoma.md) |

## How they're kept

Each client has two files:
- **`<slug>.json`** holds what the database can't: each prospecting run's brief, counts and costs, the plan (next markets, deferred areas), notes, and which vertical each search belongs to. Edit this one.
- **`<slug>.md`** is generated from the JSON plus live database facts: campaigns and enrollment, and every city pulled or reached, with counts. Don't edit it by hand.

Regenerate one client, or all active clients:

```bash
node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --client saasassins --write
```

```bash
node .claude/skills/tube-pipeline/scripts/client-ledger.mjs --all --write
```

The TuBe pipeline keeps SaaSassins' ledger up to date by itself:
- Step 0 (the brief) shows the cities already worked and the plan.
- Step 1 warns before searching a city again.
- Step 9 (`assess.mjs --final`) records the finished run and regenerates the file.

Commit and push the ledger after each run, so every computer sees it.

## What goes in

City-level counts only: no prospect names, emails or addresses.

Coverage comes from the database:
- **Map searches:** every place a search saved, by its city, deduplicated.
- **Imported lists:** each contact's own city field, or the city in its address.
