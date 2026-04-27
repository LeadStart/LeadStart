// HTML fetching + plain-text extraction utilities ported from
// server/enricher.ts:183-258. Used only by Layer 1 (website scrape) — the
// Layer 2 path (Perplexity / Claude web search) does not need these.

export async function fetchPage(url: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!response.ok) return "";
    const html = await response.text();
    return html.substring(0, 200_000);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// Manual tag-block stripper — drops <script>...</script> and
// <style>...</style> entirely, including any code/CSS inside them.
// Used before regex tag-stripping so we don't leak JS/CSS into the prompt.
export function stripTagBlocks(html: string, tagName: string): string {
  const lower = html.toLowerCase();
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let result = "";
  let pos = 0;
  while (pos < html.length) {
    const openIdx = lower.indexOf(openTag, pos);
    if (openIdx === -1) {
      result += html.substring(pos);
      break;
    }
    result += html.substring(pos, openIdx);
    const closeIdx = lower.indexOf(closeTag, openIdx);
    if (closeIdx === -1) {
      break;
    }
    pos = closeIdx + closeTag.length;
  }
  return result;
}

export function htmlToText(html: string): string {
  let text = html.substring(0, 100_000);
  text = stripTagBlocks(text, "script");
  text = stripTagBlocks(text, "style");
  text = text.replace(/<[^>]{0,500}>/g, " ");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&#?\w+;/g, " ");
  text = text.replace(/\s+/g, " ");
  text = text.trim();
  return text.substring(0, 15_000);
}

// Pull links matching contact/team/about-style URL or anchor text. Bounded
// to 4 unique pages so we don't crawl half a site for one decision maker.
export function findContactPages(html: string, baseUrl: string): string[] {
  const linkRegex = /<a[^>]{0,500}href=["']([^"']{1,500})["'][^>]{0,500}>([^<]{0,200})</gi;
  const contactKeywords =
    /about|contact|team|staff|leadership|people|our-team|meet|faculty|board|management|who-we-are/i;
  const pages: string[] = [];
  let match: RegExpExecArray | null;
  let iterations = 0;
  while ((match = linkRegex.exec(html)) !== null && iterations < 5000) {
    iterations++;
    const href = match[1];
    const text = match[2].trim();
    if (contactKeywords.test(href) || contactKeywords.test(text)) {
      try {
        const fullUrl = new URL(href, baseUrl).href;
        if (fullUrl.startsWith("http") && !fullUrl.includes("mailto:")) {
          pages.push(fullUrl);
        }
      } catch {
        // Invalid URL, skip.
      }
    }
  }
  return [...new Set(pages)].slice(0, 4);
}
