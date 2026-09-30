// Step 0: the batch brief (references/brief.md). Prints the 10 questions every
// run starts with, pre-filled with this run's answers if it has a brief, else
// the most recent run's, so the owner confirms what we're looking for before
// anything is pulled, scanned or imported. No database, no network.
//
//   node .claude/skills/tube-pipeline/scripts/brief.mjs --run <name> [--from <run>]
//   node .claude/skills/tube-pipeline/scripts/brief.mjs --run <name> --check
//
// The owner's answers are saved by writing <run>/brief.json (schema in
// references/brief.md) with confirmed_at set. --check exits 1 unless it's there.
import { args, existsSync, join, listRuns, main, readJson, runDir } from "./lib.mjs";

export const BRIEF_QUESTIONS = [
  ["area", "Area: which state, and which cities or metros? Every qualifying firm in each, or a cap per metro?"],
  ["practice", "Practice areas: which law types? Should \"lawyers\"-only listings get the broad question?"],
  ["filters", "Firm filters: minimum Google reviews, website, open; which firms to drop?"],
  ["budget", "Budget: the total for this batch (after sourcing), and is it a hard stop?"],
  ["source", "Source: Scrap.io (credits left, expiry, search lock) or Apify?"],
  ["enrichment", "Enrichment: find owner names? Recover catch-all emails? Weak email hosts set aside or enriched?"],
  ["who", "Who gets emailed: which contacts, and which TuBe results?"],
  ["campaign", "Campaign: which one, and the same copy?"],
  ["pace", "Pace and timing: start when, any deadline, add inboxes or raise the daily cap?"],
  ["flagged", "Flagged firms (wrong person, keyword-style names, titles, national firms): hold for review, or skip?"],
];
export const STANDING_RULES = [
  "TuBe scans ask Google only (no ChatGPT, no branded question)",
  "never re-scan a firm TuBe already scanned unless the owner asks",
  "ask before any bulk call to an outside service; stop on the first 403/429",
  "the copy is the owner's: the pipeline fills values, never wording",
  "hot leads get the report link, not the PDF",
  "exact counts, never \"some\"",
];

const list = (xs) => (Array.isArray(xs) && xs.length ? xs.join(", ") : "none");
function summarize(key, v) {
  if (v == null) return "(not answered)";
  switch (key) {
    case "area": {
      const caps = Object.entries(v.caps ?? {}).map(([m, n]) => `${m} ≤${n}`);
      return `${v.state ?? "?"}: ${list(v.metros)}${v.exhaustive ? " (every qualifying firm)" : caps.length ? ` (caps: ${caps.join(", ")})` : ""}`;
    }
    case "practice":
      return `groups ${list(v.groups)}${v.types ? ` (${list(v.types)})` : ""}; "lawyers"-only listings ${v.include_generic ? "INCLUDED" : "left out"}`;
    case "filters":
      return `${v.min_reviews ?? "?"}+ reviews${v.website ? ", website" : ""}${v.open_only ? ", open" : ""}; drop ${list(v.drop)}; solo attorneys ${v.solos === false ? "out" : "in"}`;
    case "budget":
      return v.total_usd == null ? `not set${v.notes ? ` (${v.notes})` : ""}` : `${v.total_usd} dollars${v.hard_stop ? ", hard stop" : ""}${v.notes ? ` (${v.notes})` : ""}`;
    case "source":
      return `${v.kind ?? "?"}${v.credits_cap ? `, up to ${v.credits_cap} credits` : ""}${v.notes ? ` (${v.notes})` : ""}`;
    case "enrichment":
      return `owner names ${v.naming ? "on" : "off"}; catch-all recovery ${v.catch_all_recovery ? "on" : "off"}; weak email hosts ${v.weak_hosts === "enrich" ? "enriched" : "set aside"}`;
    case "who":
      return `${v.personal_email_only === false ? "any address" : "named owner, verified or published personal email only"}; send ${list(v.segments)}`;
    case "campaign":
      return `${v.name ?? v.id ?? "?"}${v.copy ? ` (${v.copy})` : ", same copy"}`;
    case "pace":
      return `start ${v.start ?? "?"}${v.deadline ? `, deadline ${v.deadline}` : ""}${v.notes ? ` (${v.notes})` : ""}`;
    case "flagged":
      return v === "skip" ? "skip them" : "hold for review";
    default:
      return JSON.stringify(v);
  }
}

main(async () => {
  const a = args();
  const dir = runDir(a.run, { create: true });
  const file = join(dir, "brief.json");
  const own = existsSync(file) ? readJson(file) : null;

  if (a.check) {
    const missing = own ? BRIEF_QUESTIONS.map(([k]) => k).filter((k) => own[k] == null) : ["brief.json"];
    if (!own || !own.confirmed_at || missing.length) {
      console.log(`Run "${a.run}": brief ${!own ? "missing" : !own.confirmed_at ? "not confirmed by the owner" : `missing ${missing.join(", ")}`}. Run brief.mjs --run ${a.run} and ask the owner.`);
      process.exit(1);
    }
    console.log(`Run "${a.run}": brief confirmed ${own.confirmed_at}.`);
    return;
  }

  let base = own, from = own ? a.run : null;
  if (!base) {
    const prev = typeof a.from === "string"
      ? { name: a.from, dir: runDir(a.from) }
      : listRuns().find((r) => r.name !== a.run && existsSync(join(r.dir, "brief.json")));
    if (prev && existsSync(join(prev.dir, "brief.json"))) {
      base = readJson(join(prev.dir, "brief.json"));
      from = prev.name;
    }
  }
  console.log(own
    ? `Run "${a.run}": brief ${own.confirmed_at ? `confirmed ${own.confirmed_at}` : "NOT yet confirmed by the owner"}.`
    : base
      ? `Run "${a.run}" has no brief yet. Last answers, from run "${from}" (the starting point to confirm or change):`
      : `Run "${a.run}" has no brief, and no earlier run has one: start from the defaults in references/brief.md.`);
  BRIEF_QUESTIONS.forEach(([k, q], i) => console.log(`\n${i + 1}. ${q}\n   → ${base ? summarize(k, base[k]) : "(see references/brief.md)"}`));
  console.log(`\nStanding rules: ${STANDING_RULES.join(" · ")}.`);
  if (!own || !own.confirmed_at) {
    console.log(`\nAsk the owner all 10 in one message. Then write ${file} with their answers and confirmed_at (schema: references/brief.md).`);
  }
});
