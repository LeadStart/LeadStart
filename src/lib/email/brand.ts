// Shared email typography, so the brand face is declared in exactly one place.
//
// Poppins is the LeadStart brand font (UI_RULES.md line 9). Email cannot rely
// on it the way the app can, and the three cases behave very differently:
//
//   * Apple Mail / iOS Mail load the webfont and render real Poppins. That is
//     roughly half of all opens (Litmus, Feb 2026), so it is worth shipping.
//   * Gmail, Outlook.com and Yahoo strip webfonts entirely and fall through
//     the stack below to the recipient's system sans-serif. Same as today.
//   * Outlook on Windows uses the Word engine, which falls back to TIMES NEW
//     ROMAN when it meets a font family it does not recognise, ignoring the
//     rest of the stack. Naming Poppins first without guarding for that would
//     make Outlook worse than it is now, not better.
//
// So the <link> is wrapped in a downlevel-revealed conditional that hides it
// from Outlook, and a separate mso-only block pins Outlook to Arial. The
// non-mso <style> block deliberately omits !important, so any element with its
// own inline font-family (a monospace code chip, say) still wins.
//
// The cold-email channel does NOT use any of this: it is plain text with no
// HTML part at all. See src/lib/gmail/mime.ts.

/** Brand-first stack for the body/wrapper of a transactional email. */
export const EMAIL_FONT_STACK =
  "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Elements worth naming explicitly; some clients drop <body>-level styles. */
const TARGETS = "body, table, td, div, p, a, span, strong, b, li, h1, h2, h3, h4";

/** Drop inside <head> of every transactional template. */
export const EMAIL_FONT_HEAD = `<!--[if !mso]><!-->
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${TARGETS} { font-family: ${EMAIL_FONT_STACK}; }</style>
  <!--<![endif]-->
  <!--[if mso]>
  <style>${TARGETS} { font-family: Arial, Helvetica, sans-serif !important; }</style>
  <![endif]-->`;
