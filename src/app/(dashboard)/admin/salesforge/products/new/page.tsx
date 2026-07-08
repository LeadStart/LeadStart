"use client";

// /admin/salesforge/products/new — create a new Salesforge product.
//
// Products group sequences in Salesforge — every sequence belongs to
// one product. The fields here mirror Salesforge's CreateProductRequest
// schema: minimal (just name) up through the full ICP/pain/solution
// briefing if you want Salesforge's AI features to use it.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Save, Loader2, AlertCircle, CheckCircle } from "lucide-react";
import Link from "next/link";
import { appUrl } from "@/lib/api-url";

const LANGUAGE_OPTIONS = [
  { value: "american_english", label: "English (US)" },
  { value: "british_english", label: "English (UK)" },
  { value: "french", label: "French" },
  { value: "spanish", label: "Spanish" },
  { value: "german", label: "German" },
  { value: "italian", label: "Italian" },
  { value: "dutch", label: "Dutch" },
];

export default function NewProductPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [name, setName] = useState("");
  const [internalName, setInternalName] = useState("");
  const [language, setLanguage] = useState("american_english");
  const [industry, setIndustry] = useState("");
  const [icp, setIcp] = useState("");
  const [pain, setPain] = useState("");
  const [costOfInaction, setCostOfInaction] = useState("");
  const [solution, setSolution] = useState("");
  const [proofPoints, setProofPoints] = useState("");

  async function save() {
    setError(null);
    setSuccess(false);
    if (!name.trim()) {
      setError("Product name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(appUrl("/api/admin/salesforge/products/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          internalName: internalName.trim() || undefined,
          language,
          industry: industry.trim() || undefined,
          idealCustomerProfile: icp.trim() || undefined,
          pain: pain.trim() || undefined,
          costOfInaction: costOfInaction.trim() || undefined,
          solution: solution.trim() || undefined,
          proofPoints: proofPoints.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      setSuccess(true);
      setTimeout(() => {
        router.push("/admin/settings/api");
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href={appUrl("/admin/settings/api")}>
        <Button variant="ghost" size="sm">
          <ArrowLeft size={14} className="mr-1" /> Back to Settings
        </Button>
      </Link>

      <div className="relative overflow-hidden rounded-[12px] p-5 sm:p-7" style={{ background: "#EDEEFF", border: "1px solid #e2e8f0" }}>
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">New product</h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          Products are the offering envelope sequences sit under. The
          ICP/pain/solution fields feed Salesforge&apos;s AI features
          (auto-personalization, copy suggestions). Only the name is
          required to create the product.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Required</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="name">Product name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. LeadStart Cold Email Service" />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="internal-name">Internal name (optional)</Label>
              <Input id="internal-name" value={internalName} onChange={(e) => setInternalName(e.target.value)} placeholder="Shown only in Salesforge admin" />
            </div>
            <div className="space-y-1">
              <Label>Language</Label>
              <Select value={language} onValueChange={(v) => v && setLanguage(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Briefing (optional)</CardTitle>
          <p className="text-xs text-muted-foreground">
            These power Salesforge&apos;s AI personalization. Worth
            filling out if you plan to use auto-generated copy.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="industry">Industry</Label>
            <Input id="industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. SaaS, Construction, Real Estate" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="icp">Ideal customer profile</Label>
            <Textarea id="icp" value={icp} onChange={(e) => setIcp(e.target.value)} rows={3} placeholder="Who is this product for?" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pain">Pain</Label>
            <Textarea id="pain" value={pain} onChange={(e) => setPain(e.target.value)} rows={3} placeholder="What problem does it solve?" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cost">Cost of inaction</Label>
            <Textarea id="cost" value={costOfInaction} onChange={(e) => setCostOfInaction(e.target.value)} rows={2} placeholder="What happens if they don't fix it?" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="solution">Solution</Label>
            <Textarea id="solution" value={solution} onChange={(e) => setSolution(e.target.value)} rows={3} placeholder="How your product solves the pain" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="proof">Proof points</Label>
            <Textarea id="proof" value={proofPoints} onChange={(e) => setProofPoints(e.target.value)} rows={3} placeholder="Case studies, testimonials, key results" />
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 sticky bottom-4 z-10 bg-background/80 backdrop-blur p-3 rounded-xl border border-border/60">
        <Button onClick={save} disabled={saving} style={{ background: "#2E37FE" }}>
          {saving ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Save size={14} className="mr-1" />}
          Create product
        </Button>
        {success && (
          <span className="text-sm text-emerald-600 flex items-center gap-1">
            <CheckCircle size={14} /> Created — redirecting…
          </span>
        )}
      </div>
    </div>
  );
}
