// Self-hosted anti-bot fetch — TLS/HTTP-2 fingerprint impersonation via curl_cffi.
// Ported from the saasassins engine. Shells out to fingerprint_fetch.py and
// returns { html, status } so it drops into the fetch waterfall unchanged.
//
// This is the free, no-browser tier that defeats TLS/JA3 + HTTP-2 gating (Akamai,
// many WAFs). An optional proxy URL adds a residential-IP variant (tier 3).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024; // pages run ~0.5–1.5MB; JSON-escaping inflates that

export interface FingerprintResult {
  html: string | null;
  status: number;
  error?: string;
}

function resolvePython(): string {
  if (process.env.FINGERPRINT_PYTHON) return process.env.FINGERPRINT_PYTHON;
  return "python3";
}

function resolveHelper(): string {
  const candidates = [
    process.env.FINGERPRINT_HELPER,
    path.resolve(MODULE_DIR, "fingerprint_fetch.py"),
    path.resolve(process.cwd(), "src/fingerprint_fetch.py"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[candidates.length - 1];
}

function impersonateTarget(): string {
  return process.env.FINGERPRINT_IMPERSONATE || "chrome";
}

function runHelper(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      resolvePython(),
      [resolveHelper(), ...args],
      { timeout: REQUEST_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function parseHelperLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").filter(Boolean).pop() || "";
  return JSON.parse(line);
}

// One-time cached probe: is curl_cffi actually importable in this interpreter? A
// misconfigured Python must NOT hard-fail the caller — it reports "not configured"
// so the waterfall falls through to the next tier.
let configuredProbe: Promise<boolean> | null = null;

export function isFingerprintConfigured(): Promise<boolean> {
  if (!configuredProbe) {
    configuredProbe = (async () => {
      try {
        const parsed = parseHelperLine(await runHelper(["--check"]));
        if (parsed?.ok) {
          console.log(`[fingerprint] ready (python=${resolvePython()}, impersonate=${impersonateTarget()})`);
          return true;
        }
        console.warn(`[fingerprint] disabled — helper check failed: ${String(parsed?.error) || "unknown"}`);
        return false;
      } catch (err) {
        console.warn(
          `[fingerprint] disabled — could not run helper (python=${resolvePython()}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    })();
  }
  return configuredProbe;
}

// Fetch a URL with Chrome TLS/HTTP-2 fingerprint impersonation. `proxyUrl`, when
// set, routes through it (the residential-IP tier). Returns HTML on a <400
// response, else null + error.
export async function fingerprintFetch(url: string, proxyUrl?: string): Promise<FingerprintResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseHelperLine(await runHelper([url, impersonateTarget(), proxyUrl || "-"]));
  } catch (err) {
    const e = err as { killed?: boolean; message?: string };
    return {
      html: null,
      status: 0,
      error: e.killed ? "fingerprint fetch timeout" : `fingerprint fetch error: ${e.message}`,
    };
  }

  const status = typeof parsed?.status === "number" ? parsed.status : 0;
  let html: string | null = typeof parsed?.html === "string" ? parsed.html : null;
  if (status >= 400) html = null; // a challenge/error body is not usable content
  if (!html) {
    return {
      html: null,
      status,
      error: (parsed?.error as string) || (status >= 400 ? `target returned HTTP ${status}` : "no HTML"),
    };
  }
  return { html, status };
}
