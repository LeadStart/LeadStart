// HTML to plain text, for the text/plain alternative that rides alongside every
// transactional email.
//
// Why this exists: a single-part text/html message with no plain-text
// alternative is a well-known spam-filter signal, and it is unreadable in any
// client with images and HTML disabled. Rather than hand-maintain a second copy
// of every template (which drifts the moment someone edits the HTML), we derive
// the text part from the rendered HTML at send time.
//
// The one thing that must survive is LINKS. A transactional email is mostly a
// call to action, so an <a> becomes "Label: https://url" instead of losing the
// destination with the markup.
//
// NOT used for the cold-email channel: that path is plain text at source and
// never builds HTML at all. See src/lib/gmail/mime.ts.

// Layout-level blocks end a line. <p> is handled separately (it gets a blank
// line, so paragraphs read as paragraphs), and <li> is handled by its OPEN tag
// so the closing tag must not add a second break.
const BLOCK_CLOSE = /<\/(div|tr|h[1-6]|table|section|header|footer|blockquote)\s*>/gi;

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&hellip;/gi, "...")
    .replace(/&middot;/gi, "·")
    .replace(/&bull;/gi, "•")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    // Em and en dashes decode to a plain hyphen on purpose: outbound copy on
    // this codebase never ships an em dash.
    .replace(/&mdash;|&ndash;|&#82(1[12]);/gi, "-")
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hexCode: string) => String.fromCodePoint(parseInt(hexCode, 16)))
    // Ampersand last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/gi, "&");
}

function stripTags(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "");
}

/**
 * Render an HTML email body as readable plain text, preserving link targets.
 *
 * Exported for scripts/test-html-to-text.ts.
 */
export function htmlToPlainText(html: string): string {
  let text = html
    // Non-content first, including anything they wrap.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");

  // Links become "Label: url". Done before tags are stripped so the href
  // survives, and before block handling so the label stays on one line.
  text = text.replace(
    /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const url = decodeEntities(href).trim();
      const label = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      if (!label || label === url) return url;
      // A label that already spells out the destination does not need it twice.
      if (label.includes(url)) return label;
      return `${label}: ${url}`;
    },
  );

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    // The OPEN tag carries the bullet, so </li> is left for stripTags.
    .replace(/<li\b[^>]*>/gi, "\n- ")
    // A table cell boundary is a column gap, not a line break.
    .replace(/<\/t[dh]\s*>/gi, "  ")
    // A paragraph break is a blank line; the \n{3,} collapse below caps it.
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(BLOCK_CLOSE, "\n")
    .replace(/<hr\s*\/?>/gi, "\n");

  text = decodeEntities(stripTags(text));

  return text
    // Any literal em dash that came through the HTML is normalised too.
    .replace(/—/g, "-")
    .replace(/\r\n/g, "\n")
    // Collapse horizontal runs, then trim each line, then collapse blank runs.
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
