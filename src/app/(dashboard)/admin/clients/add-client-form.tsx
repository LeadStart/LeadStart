"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UserPlus } from "lucide-react";
import { useUser } from "@/hooks/use-user";

export function AddClientForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { organizationId } = useUser();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!organizationId) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    const supabase = createClient();
    const { error } = await supabase.from("clients").insert({
      name,
      contact_email: email || null,
      organization_id: organizationId,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setName("");
    setEmail("");
    setSuccess(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]/10">
          <UserPlus size={16} className="text-[#2E37FE]" />
        </div>
        <CardTitle className="text-base">Add Client</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex items-end gap-4">
          <div className="space-y-1 flex-1">
            <Label htmlFor="clientName" className="text-sm font-medium">Name</Label>
            <Input
              id="clientName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Client name"
              required
            />
          </div>
          <div className="space-y-1 flex-1">
            <Label htmlFor="clientEmail" className="text-sm font-medium">Email (optional)</Label>
            <Input
              id="clientEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@company.com"
            />
          </div>
          <Button type="submit" disabled={loading} style={{ background: '#2E37FE' }}>
            {loading ? "Adding..." : "Add Client"}
          </Button>
        </form>
        {error && (
          <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        {success && (
          <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 p-3">
            <p className="text-sm text-emerald-700">Client added successfully!</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
