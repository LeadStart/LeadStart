// Anthropic SDK singleton. Lazy-initialised so the module loads without
// throwing during builds or unit tests that don't actually call Claude.
//
// The API key comes from ANTHROPIC_API_KEY (.env.local locally, Vercel
// env in production). If unset, any attempt to call Claude returns an
// explicit error rather than a silent failure.

import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local for local dev or Vercel env for production."
    );
    this.name = "MissingAnthropicKeyError";
  }
}

/**
 * Return the singleton Anthropic client. Throws MissingAnthropicKeyError
 * if the env var is missing, so callers can distinguish "API down" from
 * "misconfigured."
 */
export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new MissingAnthropicKeyError();
  cached = new Anthropic({ apiKey });
  return cached;
}

/** Reset the singleton — used by tests that swap the key mid-process. */
export function _resetAnthropicForTests(): void {
  cached = null;
}
