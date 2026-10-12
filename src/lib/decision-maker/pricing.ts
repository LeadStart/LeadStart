// Per-token pricing (USD) for the models we use across both enrichment
// layers. Pricing is per-token (not per-million) so calculateCost can sum
// directly. Update if Anthropic / Perplexity change their rates.
//
// Layer 1 (the site read) uses Claude Haiku 4.5. Layer 2 (the web lookup) uses
// Claude Haiku 5.5 with one web search: owner decision 2026-10-11, replacing
// Perplexity Sonar (Layer 2's only engine from 2026-08-28). Perplexity is still
// what name→domain discovery uses.

export const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
export const LAYER2_MODEL_ID = "claude-haiku-5-5";
export const PERPLEXITY_MODEL = "sonar";
// Claude's web search tool: $10 per 1,000 searches, billed on top of tokens.
export const WEB_SEARCH_COST_USD = 0.01;

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  [HAIKU_MODEL_ID]: { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  // Haiku 5.5 rates for prompts up to 100K tokens ($0.50 / $2.50 beyond). A
  // one-search lookup reads ~13K tokens (2026-10-11 test), far below that.
  [LAYER2_MODEL_ID]: { input: 0.1 / 1_000_000, output: 0.5 / 1_000_000 },
  sonar: { input: 1.0 / 1_000_000, output: 1.0 / 1_000_000 },
  "sonar-pro": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  "sonar-reasoning-pro": { input: 2.0 / 1_000_000, output: 8.0 / 1_000_000 },
};

export function calculateCost(
  usage: { input_tokens: number; output_tokens: number },
  model: string,
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING[HAIKU_MODEL_ID];
  return usage.input_tokens * pricing.input + usage.output_tokens * pricing.output;
}

export function isPerplexityModel(model: string): boolean {
  return model.startsWith("sonar");
}
