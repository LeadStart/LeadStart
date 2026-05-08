"use client";

// /admin/salesforge/custom-vars — read-only list of custom variables
// defined in the Salesforge workspace. Salesforge's public API doesn't
// expose CRUD for custom vars (only GET), so this is a viewer.

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Variable, AlertCircle } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface CustomVar {
  id?: string;
  name?: string;
  description?: string;
  defaultValue?: string;
}

export default function CustomVariablesPage() {
  const [vars, setVars] = useState<CustomVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(appUrl("/api/admin/salesforge/custom-vars"));
        const data = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        setVars(data.custom_vars ?? []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7" style={{ background: "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)", border: "1px solid rgba(46,55,254,0.2)" }}>
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">Custom variables</h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          These are the variables you can use as <code>{`{{name}}`}</code>{" "}
          in step subjects and bodies. Read-only here — to add or edit,
          go to Salesforge → Workspace settings → Custom variables.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Variable size={16} /> {loading ? "Loading…" : `${vars.length} variables`}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Loader2 size={20} className="inline animate-spin mr-2" />
              Loading…
            </div>
          ) : vars.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No custom variables defined.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Default value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vars.map((v, i) => (
                  <TableRow key={v.id ?? i}>
                    <TableCell className="font-mono text-xs">
                      {`{{${v.name ?? "(unnamed)"}}}`}
                    </TableCell>
                    <TableCell className="text-sm">{v.description ?? "—"}</TableCell>
                    <TableCell className="text-sm">{v.defaultValue ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
