"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Pencil, Mail, Phone, Contact, User } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { Client } from "@/types/app";

/**
 * Contact card on the client dossier: the client's on-file contact details
 * (email + phone). Editable by owner/va, saved through /api/clients/[id]
 * (service-role write + validation) so it actually persists. This is the
 * durable "email on file" that pre-fills quotes and shows in Campaigns.
 */
export function ContactSection({
  client,
  onSaved,
}: {
  client: Client;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState(client.contact_first_name ?? "");
  const [lastName, setLastName] = useState(client.contact_last_name ?? "");
  const [email, setEmail] = useState(client.contact_email ?? "");
  const [phone, setPhone] = useState(client.phone_number ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/clients/${client.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_first_name: firstName.trim() || null,
          contact_last_name: lastName.trim() || null,
          contact_email: email.trim() || null,
          phone_number: phone.trim() || null,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || "Could not save contact");
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setFirstName(client.contact_first_name ?? "");
    setLastName(client.contact_last_name ?? "");
    setEmail(client.contact_email ?? "");
    setPhone(client.phone_number ?? "");
    setError(null);
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Contact size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Contact</CardTitle>
        </div>
        {!editing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            className="gap-1.5"
          >
            <Pencil size={13} />
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contact-first">First name</Label>
                <Input
                  id="contact-first"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Jane"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact-last">Last name</Label>
                <Input
                  id="contact-last"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Doe"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contact-email">Contact email</Label>
                <Input
                  id="contact-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="client@company.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact-phone">Phone</Label>
                <Input
                  id="contact-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                />
              </div>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={save}
                disabled={saving}
                style={{ background: "#2E37FE" }}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={cancel}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <User size={14} className="text-muted-foreground shrink-0" />
              {client.contact_first_name || client.contact_last_name ? (
                <span className="font-medium">
                  {[client.contact_first_name, client.contact_last_name]
                    .filter(Boolean)
                    .join(" ")}
                </span>
              ) : (
                <span className="text-muted-foreground">No contact name</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Mail size={14} className="text-muted-foreground shrink-0" />
              {client.contact_email ? (
                <span>{client.contact_email}</span>
              ) : (
                <span className="text-amber-600">No email on file</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Phone size={14} className="text-muted-foreground shrink-0" />
              {client.phone_number ? (
                <span>{client.phone_number}</span>
              ) : (
                <span className="text-muted-foreground">No phone on file</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
