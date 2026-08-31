// Central role helpers. The client/admin split was duplicated as inline
// ternaries across the shell + routing files; the self-serve 'buyer' role adds a
// third home, so route decisions go through here to keep every surface in sync.

/** Owner + VA are the agency-admin roles (the /admin portal). */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "va";
}

/** Self-serve token buyers (the /buyer portal). */
export function isBuyerRole(role: string | null | undefined): boolean {
  return role === "buyer";
}

/** The portal home path for a role: buyer -> /buyer, owner/va -> /admin, else /client. */
export function roleHomePath(role: string | null | undefined): string {
  if (role === "buyer") return "/buyer";
  if (role === "owner" || role === "va") return "/admin";
  return "/client";
}
