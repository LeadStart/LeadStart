// "View as client": the admin-side portal preview.
//
// An owner/VA can render the REAL client portal for one of their clients so
// they see exactly what that client sees. This is deliberately NOT
// impersonation: there is no session swap, no service-role proxy, and no JWT
// re-issue. The admin stays themselves the whole time.
//
// It works because owner/VA RLS already grants SELECT on every table the client
// portal reads (clients, campaigns, campaign_snapshots, campaign_steps,
// campaign_enrollments, kpi_reports, lead_feedback, lead_replies, profiles
// each have an "Admin/VA can view all ... in org" or `_admin_all` policy). So
// the preview is a DISPLAY-SCOPE override: we tell the portal which client_id
// to render, and the admin's own credentials fetch it.
//
// Two independent guards keep it inside the org:
//   1. POST /api/admin/view-as verifies the client belongs to the caller's org
//      before setting the cookie, and the cookie is httpOnly so page JS can't
//      forge one.
//   2. RLS is the backstop. Even a forged client_id from another org returns
//      zero rows, because every policy above is org-scoped. No data can leak.
//
// The preview is READ-ONLY. See PREVIEW_READONLY_MESSAGE. The portal's write
// paths (feedback submit, account/password/notification/report/signature saves)
// are all disabled while previewing, because they would otherwise write as the
// ADMIN: submitting feedback under the wrong user, or worse, changing the
// owner's own login email and password from the client settings page.

/** httpOnly cookie holding the client_id being previewed. */
export const VIEW_AS_COOKIE = "ls_view_as_client";

/**
 * Request header the auth middleware forwards to server components once it has
 * confirmed the cookie belongs to an owner/VA. Any inbound value is stripped
 * first, exactly like the x-user-* headers.
 */
export const VIEW_AS_HEADER = "x-view-as-client";

/** How long a preview lasts before it lapses on its own (8h = one work day). */
export const VIEW_AS_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Shown wherever a write is blocked during a preview. */
export const PREVIEW_READONLY_MESSAGE =
  "Read-only while viewing as a client. Exit the preview to make changes.";

/**
 * A client_id is only ever a UUID. Validating the shape in the middleware means
 * a malformed cookie is ignored rather than forwarded into a query.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClientId(value: string | null | undefined): boolean {
  return !!value && UUID_RE.test(value);
}
