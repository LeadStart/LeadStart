// Shared Perplexity Sonar client. Extracted verbatim from the decision-maker
// Layer 2 path (src/lib/decision-maker/layer2.ts) so other features (e.g.
// name→domain discovery) can reuse it. Plain fetch, no SDK. Token cost via the
// decision-maker pricing table.

import { calculateCost } from "../decision-maker/pricing";

const DEFAULT_SYSTEM_PROMPT =
  "You are a business research assistant. Return ONLY valid JSON, no markdown, no explanation, no preamble.";

export interface PerplexityCallResult {
  text: string;
  cost: number;
  // Top-level `citations` array (real URLs the answer was grounded on). Layer 2
  // ignored these; domain discovery uses them to catch hallucinated domains.
  citations: string[];
  usage: { input_tokens: number; output_tokens: number };
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  citations?: string[];
}

export async function callPerplexity(
  apiKey: string,
  prompt: string,
  model: string,
  opts: {
    maxTokens?: number;
    systemPrompt?: string;
    // "year" (default) | any recency string | null to omit the filter entirely.
    searchRecencyFilter?: string | null;
    // Hard client-side timeout. Perplexity is called inline inside 60s-budget
    // crons (naming Layer 2, domain discovery); without this a single hung
    // request blows the whole tick past maxDuration and loses the batch's work
    // (SPEND-11). Defaults to 25s, comfortably inside the per-item budgets.
    timeoutMs?: number;
  } = {},
): Promise<PerplexityCallResult> {
  const maxTokens = opts.maxTokens ?? 200;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const recency = opts.searchRecencyFilter === undefined ? "year" : opts.searchRecencyFilter;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
    return_citations: true,
  };
  if (recency) body.search_recency_filter = recency;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
  let response: Response;
  try {
    response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new Error(
      `Perplexity request ${timedOut ? "timed out" : "failed"}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as PerplexityResponse;
  const text = data.choices?.[0]?.message?.content || "";
  const usage = {
    input_tokens: data.usage?.prompt_tokens || 0,
    output_tokens: data.usage?.completion_tokens || 0,
  };
  const cost = calculateCost(usage, model);
  const citations = Array.isArray(data.citations)
    ? data.citations.filter((c): c is string => typeof c === "string")
    : [];
  return { text, cost, citations, usage };
}
