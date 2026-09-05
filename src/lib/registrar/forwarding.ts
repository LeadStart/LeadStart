// URL forwarding helpers (pure, no I/O). A sending domain's bare hostname
// 301-redirects to the client's real site so a lookalike domain never shows a
// dead parked page. Porkbun sets this over its API (porkbun.ts); Spaceship
// cannot (dashboard-only) and its client throws ManualForwardingRequiredError.
//
// Everything here is pure and exported for tests: the destination validator, the
// default forward set (apex + www, permanent), and the idempotent diff the
// Porkbun client applies with add/delete calls (Porkbun has no "edit forward").

import type { UrlForward, UrlForwardInput, UrlForwardType } from "./types";

/** Thrown by registrar clients that can't set forwarding through their API. */
export class ManualForwardingRequiredError extends Error {
  readonly registrar: string;
  constructor(registrar: string, message: string) {
    super(message);
    this.name = "ManualForwardingRequiredError";
    this.registrar = registrar;
  }
}

// Human-facing instructions for the registrars where forwarding is a manual step
// (Spaceship's API can't do it; a 'manual'-registrar domain has hand-managed DNS).
// Kept here so the provider client, the API route, and the UI all read one source.
export const MANUAL_FORWARDING_MESSAGE: Record<string, string> = {
  spaceship:
    "Spaceship has no URL-forwarding API. Set the redirect by hand in the Spaceship " +
    "dashboard: Domain → Advanced DNS / Forwarding → add a redirect to the destination URL.",
  manual:
    "This domain's DNS is managed by hand: add the redirect at your DNS or hosting provider.",
};

/** The manual-setup instruction string for a registrar without API forwarding. */
export function manualForwardingMessage(registrar: string): string {
  return MANUAL_FORWARDING_MESSAGE[registrar] ?? MANUAL_FORWARDING_MESSAGE.manual;
}

/**
 * Normalise a user-typed destination into an absolute URL, or null if it can't
 * be one. Adds https:// when no scheme is given, requires a dotted host (a real
 * TLD), and strips a lone trailing slash so equality is stable. Only http/https.
 */
export function normalizeDestinationUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Host must look like a real domain (label.tld), no spaces.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return null;
  const bare = url.pathname === "/" && !url.search && !url.hash;
  return bare ? `${url.protocol}//${url.host}` : url.toString();
}

/**
 * The forwards a sending domain should have: the apex, plus www by default, both
 * pointing at `destination`. Permanent (301) and includePath off by default: a
 * throwaway domain's paths don't map onto the real site's structure, so every
 * hit lands on the destination root. Returns [] if the destination is invalid.
 */
export function defaultForwards(
  destination: string,
  opts?: { www?: boolean; includePath?: boolean; type?: UrlForwardType },
): UrlForwardInput[] {
  const location = normalizeDestinationUrl(destination);
  if (!location) return [];
  const type: UrlForwardType = opts?.type ?? "permanent";
  const includePath = opts?.includePath ?? false;
  const www = opts?.www ?? true;
  const subdomains = www ? ["", "www"] : [""];
  return subdomains.map((subdomain) => ({
    subdomain,
    location,
    type,
    includePath,
    wildcard: false,
  }));
}

/** Two forwards are the same if every managed field matches (id ignored). */
export function forwardsEqual(a: UrlForwardInput, b: UrlForwardInput): boolean {
  return (
    normSub(a.subdomain) === normSub(b.subdomain) &&
    normLoc(a.location) === normLoc(b.location) &&
    a.type === b.type &&
    a.includePath === b.includePath &&
    a.wildcard === b.wildcard
  );
}

function normSub(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

/** Lowercase + drop a lone trailing slash so "https://X.com" == "https://x.com/". */
function normLoc(s: string): string {
  const t = (s ?? "").trim().toLowerCase();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

export interface ForwardDiff {
  add: UrlForwardInput[];
  del: UrlForward[];
  keep: UrlForward[];
}

/**
 * Compute the add / delete / keep sets to make a domain's forwards match
 * `desired`. Ownership is by SUBDOMAIN SLOT: for each desired subdomain we keep
 * an exact match, or delete what's there and add the new one. Forwards on
 * subdomains the desired set never mentions are left completely alone (same rule
 * as the DNS diff's untouched groups): we never delete a forward we didn't set.
 * Idempotent: re-applying an already-correct set produces no writes.
 */
export function diffForwards(
  current: UrlForward[],
  desired: UrlForwardInput[],
): ForwardDiff {
  const diff: ForwardDiff = { add: [], del: [], keep: [] };
  const managed = new Set(desired.map((d) => normSub(d.subdomain)));
  const consumed = new Set<UrlForward>();

  for (const want of desired) {
    const slot = normSub(want.subdomain);
    const inSlot = current.filter((c) => normSub(c.subdomain) === slot);
    const exact = inSlot.find((c) => !consumed.has(c) && forwardsEqual(c, want));
    if (exact) {
      consumed.add(exact);
      diff.keep.push(exact);
      // Any other forward in this slot is a stale duplicate → delete it.
      for (const c of inSlot) if (!consumed.has(c)) { consumed.add(c); diff.del.push(c); }
    } else {
      // No exact match: replace whatever is in this slot.
      for (const c of inSlot) if (!consumed.has(c)) { consumed.add(c); diff.del.push(c); }
      diff.add.push(want);
    }
  }

  // Forwards on unmanaged subdomains are left alone.
  for (const c of current) {
    if (!consumed.has(c) && !managed.has(normSub(c.subdomain))) diff.keep.push(c);
  }
  return diff;
}
