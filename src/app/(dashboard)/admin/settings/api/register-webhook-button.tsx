"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, Webhook } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface Props {
  /** Current org.instantly_webhook_id value (null when not yet registered). */
  initialWebhookId: string | null;
  /** Whether the org has an Instantly API key saved — button disables without one. */
  hasApiKey: boolean;
}

type RegistrationState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; webhookId: string; alreadyRegistered: boolean }
  | { kind: "error"; message: string };

export function RegisterWebhookButton({ initialWebhookId, hasApiKey }: Props) {
  // Seed the state with whatever was already stored — if a prior registration
  // landed, we skip straight to "registered" without needing a round-trip.
  const [state, setState] = useState<RegistrationState>(
    initialWebhookId
      ? { kind: "success", webhookId: initialWebhookId, alreadyRegistered: true }
      : { kind: "idle" }
  );

  const isRegistered = state.kind === "success";

  async function handleRegister() {
    setState({ kind: "loading" });
    try {
      const res = await fetch(appUrl("/api/instantly/register-webhook"), {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setState({
          kind: "error",
          message: data.error || `Request failed (${res.status})`,
        });
        return;
      }
      setState({
        kind: "success",
        webhookId: data.webhook_id,
        alreadyRegistered: Boolean(data.already_registered),
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  const disabled = !hasApiKey || isRegistered || state.kind === "loading";
  const buttonLabel = isRegistered
    ? "Webhook registered"
    : state.kind === "loading"
      ? "Registering..."
      : "Register webhook";

  return (
    <div className="space-y-3">
      {!hasApiKey && (
        <p className="text-sm text-muted-foreground">
          Save your Instantly API key above before registering a webhook.
        </p>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Button
          onClick={handleRegister}
          disabled={disabled}
          variant={isRegistered ? "outline" : "default"}
          style={isRegistered ? undefined : { background: "#2E37FE" }}
        >
          <Webhook size={14} className="mr-2" />
          {buttonLabel}
        </Button>

        {isRegistered && (
          <span className="text-xs text-muted-foreground font-mono">
            id: {state.webhookId}
          </span>
        )}
      </div>

      {state.kind === "success" && !state.alreadyRegistered && (
        <div className="flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
          <CheckCircle size={16} className="text-emerald-500 mt-0.5" />
          <div className="text-sm text-emerald-700">
            <p className="font-medium">Webhook registered with Instantly.</p>
            <p className="text-xs text-emerald-600 mt-0.5">
              Reply-routing is now live. New replies will start landing in the inbox within seconds
              of being received by your hosted mailboxes.
            </p>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3">
          <XCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{state.message}</p>
        </div>
      )}
    </div>
  );
}
