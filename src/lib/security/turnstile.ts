// Cloudflare Turnstile server-side verification for public / auth forms.
//
// INERT UNTIL CONFIGURED: with no TURNSTILE_SECRET_KEY in the env, verifyTurnstile()
// returns { success: true, skipped: true } so nothing breaks before the widget is
// provisioned (a site key on the form + the secret here). This mirrors the repo's
// other "no-op until the secret exists" guards (the Unipile webhook).
//
// Once the secret IS set the gate is enforced fail-CLOSED: a missing or invalid
// token fails, and a transient error verifying with Cloudflare also fails
// (someone set the secret because they want the gate — silently waving traffic
// past a configured challenge is worse than a rare false reject, and the public
// forms already tell users they can reach us directly).
//
// Activation (Daniel): create a Turnstile widget at
// https://dash.cloudflare.com/?to=/:account/turnstile , then set
//   TURNSTILE_SECRET_KEY               (server, this file)
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY     (client, the <TurnstileWidget> component)
// The marketing-site quote form (separate repo) also needs the widget + to POST
// the token as `turnstileToken` to /api/contact.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  /** True when no secret is configured, so the caller can treat it as a pass. */
  skipped: boolean;
  errorCodes?: string[];
}

/** Whether the server-side gate is active (a secret is present). */
export function turnstileConfigured(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { success: true, skipped: true };
  if (!token || typeof token !== "string") {
    return { success: false, skipped: false, errorCodes: ["missing-input-response"] };
  }

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp && remoteIp !== "unknown") form.set("remoteip", remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return {
      success: data.success === true,
      skipped: false,
      errorCodes: data["error-codes"],
    };
  } catch (err) {
    console.error("[turnstile] verify request failed (failing closed):", err);
    return { success: false, skipped: false, errorCodes: ["internal-error"] };
  }
}
