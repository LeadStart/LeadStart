// Per-token pricing (USD) for the models we use across both enrichment
// layers. Pricing is per-token (not per-million) so calculateCost can sum
// directly. Update if Anthropic / Perplexity change their rates.
//
// Layer 1 always uses Claude Haiku 4.5. Layer 2 defaults to Perplexity
// 'sonar' (cheapest of the three) but the worker falls back to the
// Claude web_search tool if no Perplexity key is configured.

export const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
export const DEFAULT_LAYER2_MODEL = "sonar";

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  [HAIKU_MODEL_ID]: { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
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
