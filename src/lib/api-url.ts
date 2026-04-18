/**
 * The app is served under a `/app` basePath (see next.config.ts).
 *
 * Next.js auto-prefixes basePath for `Link`, `router.push`, and `redirect()`
 * from `next/navigation`, but NOT for `fetch()` to absolute paths or for
 * server-side URLs built via string concatenation. This helper closes that gap.
 */
export const APP_BASE_PATH = "/app";

/**
 * Prepend the app's basePath to an absolute path.
 *
 * @example
 *   fetch(appUrl("/api/invite"))
 *   // → fetch("/app/api/invite")
 *
 *   const inviteLink = `${origin}${appUrl("/accept-invite")}?token=${token}`;
 *   // → `https://leadstart.io/app/accept-invite?token=...`
 */
export function appUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${APP_BASE_PATH}${normalized}`;
}
