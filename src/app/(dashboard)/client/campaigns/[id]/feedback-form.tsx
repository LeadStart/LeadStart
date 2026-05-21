"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FeedbackStatus } from "@/types/app";

const FEEDBACK_OPTIONS: { value: FeedbackStatus; label: string }[] = [
  { value: "good_lead", label: "Good Lead" },
  { value: "interested", label: "Interested" },
  { value: "bad_lead", label: "Bad Lead" },
  { value: "wrong_person", label: "Wrong Person" },
  { value: "already_contacted", label: "Already Contacted" },
  { value: "not_interested", label: "Not Interested" },
  { value: "other", label: "Other" },
];

export function FeedbackForm({ campaignId }: { campaignId: string }) {
  const [leadEmail, setLeadEmail] = useState("");
  const [leadCompany, setLeadCompany] = useState("");
  const [status, setStatus] = useState<FeedbackStatus | "">("");
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!status) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error } = await supabase.from("lead_feedback").insert({
      campaign_id: campaignId,
      lead_email: leadEmail,
      lead_company: leadCompany || null,
      status,
      comment: comment || null,
      submitted_by: user?.id,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setLeadEmail("");
    setLeadCompany("");
    setStatus("");
    setComment("");
    setSuccess(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Submit Lead Feedback</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="leadEmail">Lead Email</Label>
              <Input
                id="leadEmail"
                type="email"
                value={leadEmail}
                onChange={(e) => setLeadEmail(e.target.value)}
                placeholder="lead@company.com"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="leadCompany">Company (optional)</Label>
              <Input
                id="leadCompany"
                value={leadCompany}
                onChange={(e) => setLeadCompany(e.target.value)}
                placeholder="Company name"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Feedback</Label>
            <Select
              value={status}
              onValueChange={(val) => setStatus(val as FeedbackStatus)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select feedback..." />
              </SelectTrigger>
              <SelectContent>
                {FEEDBACK_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="comment">Comment (optional)</Label>
            <Textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Any additional notes..."
              rows={2}
            />
          </div>
          <Button type="submit" disabled={loading || !status}>
            {loading ? "Submitting..." : "Submit Feedback"}
          </Button>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {success && <p className="text-sm text-green-600">Feedback submitted!</p>}
        </form>
      </CardContent>
    </Card>
  );
}
