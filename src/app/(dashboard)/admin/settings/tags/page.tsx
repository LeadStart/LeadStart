"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tags,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Inbox,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import type { MailboxTagSummary } from "@/lib/mailboxes/tags";
import { MAX_TAG_LEN } from "@/lib/mailboxes/tags";
import { appUrl } from "@/lib/api-url";

type Banner = { kind: "success" | "error"; message: string } | null;

// React key / edit-delete target. Registry rows have an id; ad-hoc (in-use only)
// rows don't, so key by the case-insensitive name, which is unique per the list.
const keyOf = (t: MailboxTagSummary) => t.name.toLowerCase();

function TagChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#2E37FE]/10 px-2.5 py-1 text-sm font-medium text-[#2E37FE]">
      {name}
    </span>
  );
}

export default function TagsPage() {
  const [tags, setTags] = useState<MailboxTagSummary[]>([]);
  const [registryAvailable, setRegistryAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(null);

  // Add
  const [newTag, setNewTag] = useState("");
  const [adding, setAdding] = useState(false);

  // Inline rename (one at a time), keyed by keyOf(tag)
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirm (one at a time)
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const flash = useCallback((b: Banner) => {
    setBanner(b);
    if (b) setTimeout(() => setBanner(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(appUrl("/api/admin/mailbox-tags"));
      const data = await res.json();
      if (res.ok) {
        setTags((data.tags ?? []) as MailboxTagSummary[]);
        setRegistryAvailable(data.registry_available !== false);
      } else {
        flash({ kind: "error", message: data.error ?? "Failed to load tags" });
      }
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Failed to load tags" });
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newTag.trim();
    if (!name) return;
    setAdding(true);
    try {
      const res = await fetch(appUrl("/api/admin/mailbox-tags"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewTag("");
        flash({ kind: "success", message: `Added “${name}”.` });
        await load();
      } else {
        flash({ kind: "error", message: data.error ?? "Couldn’t add tag" });
      }
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Couldn’t add tag" });
    } finally {
      setAdding(false);
    }
  }

  function startEdit(t: MailboxTagSummary) {
    setConfirmKey(null);
    setEditingKey(keyOf(t));
    setEditName(t.name);
  }

  async function handleRename(t: MailboxTagSummary) {
    const next = editName.trim();
    if (!next || next === t.name) {
      setEditingKey(null);
      return;
    }
    setSavingEdit(true);
    try {
      const res = await fetch(appUrl("/api/admin/mailbox-tags"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, name: t.name, new_name: next }),
      });
      const data = await res.json();
      if (res.ok) {
        setEditingKey(null);
        flash({
          kind: "success",
          message: `Renamed to “${next}”${
            data.mailboxes_updated ? ` · updated ${data.mailboxes_updated} inbox${data.mailboxes_updated === 1 ? "" : "es"}` : ""
          }.`,
        });
        await load();
      } else {
        flash({ kind: "error", message: data.error ?? "Couldn’t rename tag" });
      }
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Couldn’t rename tag" });
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(t: MailboxTagSummary) {
    setDeletingKey(keyOf(t));
    try {
      const res = await fetch(appUrl("/api/admin/mailbox-tags"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, name: t.name }),
      });
      const data = await res.json();
      if (res.ok) {
        flash({
          kind: "success",
          message: `Deleted “${t.name}”${
            data.mailboxes_updated ? ` · removed from ${data.mailboxes_updated} inbox${data.mailboxes_updated === 1 ? "" : "es"}` : ""
          }.`,
        });
        await load();
      } else {
        flash({ kind: "error", message: data.error ?? "Couldn’t delete tag" });
      }
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Couldn’t delete tag" });
    } finally {
      setDeletingKey(null);
      setConfirmKey(null);
    }
  }

  return (
    <div className="space-y-6">
      {banner && (
        <div
          className={`flex items-center gap-2 rounded-lg border p-3 ${
            banner.kind === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
              : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {banner.kind === "success" ? <CheckCircle size={16} /> : <XCircle size={16} />}
          <span className="text-sm font-medium">{banner.message}</span>
        </div>
      )}

      {!registryAvailable && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-sm">
            The tag registry table isn’t set up yet: apply migration{" "}
            <span className="font-mono">00111</span>. Until then you can rename and
            delete tags already in use, but adding brand-new tags won’t save.
          </p>
        </div>
      )}

      {/* Add a tag */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Plus size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">Add a tag</CardTitle>
            <p className="text-xs text-muted-foreground">
              Tags label your sending inboxes (Sending → Mailboxes) so the campaign
              mailbox picker can add a whole pool at once.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex items-end gap-3">
            <div className="space-y-1 flex-1 max-w-sm">
              <Label htmlFor="newTag" className="text-sm font-medium">
                Tag name
              </Label>
              <Input
                id="newTag"
                value={newTag}
                maxLength={MAX_TAG_LEN}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="e.g. Agency, Client A warm pool"
              />
            </div>
            <Button type="submit" disabled={adding || !newTag.trim()} style={{ background: "#2E37FE" }}>
              {adding ? "Adding..." : "Add tag"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Tag list */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Tags size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">
            All tags{tags.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">({tags.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tags yet. Add one above, or tag an inbox on Sending → Mailboxes.
            </p>
          ) : (
            <div className="space-y-2">
              {tags.map((t) => {
                const k = keyOf(t);
                const isEditing = editingKey === k;
                const isConfirming = confirmKey === k;
                return (
                  <div
                    key={k}
                    className="rounded-xl border border-border/50 p-3 transition-colors hover:bg-muted/30"
                  >
                    {isEditing ? (
                      /* Rename mode */
                      <div className="flex items-center gap-2">
                        <Input
                          value={editName}
                          maxLength={MAX_TAG_LEN}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(t);
                            else if (e.key === "Escape") setEditingKey(null);
                          }}
                          className="h-8 w-64 text-sm"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          onClick={() => handleRename(t)}
                          disabled={savingEdit}
                          className="h-8 text-xs"
                          style={{ background: "#2E37FE" }}
                        >
                          <Check size={12} className="mr-1" />
                          {savingEdit ? "Saving..." : "Save"}
                        </Button>
                        <button
                          onClick={() => setEditingKey(null)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                          aria-label="Cancel rename"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      /* View mode */
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <TagChip name={t.name} />
                          {!t.registered && (
                            <span className="text-[11px] font-medium text-amber-600" title="In use on inboxes but not in the registry: rename or add it to adopt it">
                              unregistered
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Inbox size={12} />
                            {t.mailbox_count > 0
                              ? `${t.mailbox_count} inbox${t.mailbox_count === 1 ? "" : "es"}`
                              : "unused"}
                          </span>

                          {isConfirming ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">
                                {t.mailbox_count > 0
                                  ? `Remove from ${t.mailbox_count} inbox${t.mailbox_count === 1 ? "" : "es"}?`
                                  : "Delete this tag?"}
                              </span>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => handleDelete(t)}
                                disabled={deletingKey === k}
                                className="h-7 text-xs"
                              >
                                {deletingKey === k ? "..." : "Confirm"}
                              </Button>
                              <button
                                onClick={() => setConfirmKey(null)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                                aria-label="Cancel delete"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => startEdit(t)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                                title="Rename"
                                aria-label={`Rename ${t.name}`}
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                onClick={() => {
                                  setEditingKey(null);
                                  setConfirmKey(k);
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                                title="Delete"
                                aria-label={`Delete ${t.name}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
