#!/usr/bin/env node

// Validates vercel.json well enough to catch the shape-level regressions
// that would silently block Vercel deploys. Not a full schema check —
// just the fields we actually use (framework, crons[].path, crons[].schedule).
// Cron schedule validation is a light regex; Vercel will catch subtler
// errors, but this stops obvious typos at PR time.

import { readFileSync } from "node:fs";

const path = "vercel.json";
let raw;
try {
  raw = readFileSync(path, "utf8");
} catch (err) {
  console.error(`[vercel.json] cannot read file: ${err.message}`);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(raw);
} catch (err) {
  console.error(`[vercel.json] invalid JSON: ${err.message}`);
  process.exit(1);
}

const errors = [];

if (json.framework !== undefined && typeof json.framework !== "string") {
  errors.push("framework must be a string if present");
}

if (json.crons !== undefined) {
  if (!Array.isArray(json.crons)) {
    errors.push("crons must be an array");
  } else {
    // Matches 5-field POSIX cron. Each field is one of: *, number,
    // step (*/n or n/m), range (n-m), or list (a,b,c).
    const field = String.raw`(\*|\d+|\*\/\d+|\d+\/\d+|\d+-\d+|(?:\d+,)+\d+)`;
    const cronRe = new RegExp(
      `^${field}\\s+${field}\\s+${field}\\s+${field}\\s+${field}$`,
    );
    const seenPaths = new Set();
    json.crons.forEach((cron, i) => {
      const label = `crons[${i}]`;
      if (!cron || typeof cron !== "object") {
        errors.push(`${label}: must be an object`);
        return;
      }
      if (typeof cron.path !== "string" || !cron.path.startsWith("/")) {
        errors.push(`${label}.path: must be a string starting with /`);
      } else if (seenPaths.has(cron.path)) {
        errors.push(`${label}.path: duplicate (${cron.path})`);
      } else {
        seenPaths.add(cron.path);
      }
      if (typeof cron.schedule !== "string") {
        errors.push(`${label}.schedule: must be a string`);
      } else if (!cronRe.test(cron.schedule.trim())) {
        errors.push(
          `${label}.schedule: "${cron.schedule}" doesn't look like a 5-field cron expression`,
        );
      }
    });
  }
}

if (errors.length > 0) {
  console.error("[vercel.json] validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `[vercel.json] ok — ${json.crons?.length ?? 0} cron(s), framework=${json.framework ?? "(unset)"}`,
);
