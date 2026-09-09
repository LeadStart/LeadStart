"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { MapsPlace } from "@/types/app";
import {
  MAPS_EXPORT_COLUMNS,
  DEFAULT_MAPS_EXPORT_KEYS,
  buildMapsCsvRows,
} from "@/lib/maps/export-columns";
import { toCsv, downloadCsv } from "@/lib/csv/to-csv";

// "Download CSV" for the current Maps results: pick which columns to include
// (Domain on by default) and export the whole run client-side from what's already
// on screen — no server round-trip, no spend. When rows are selected in the table
// the picker offers exporting just those.
export function MapsExportDialog({
  results,
  selectedIds,
}: {
  results: MapsPlace[];
  selectedIds: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<Set<string>>(new Set(DEFAULT_MAPS_EXPORT_KEYS));
  const [onlySelected, setOnlySelected] = useState(false);

  const places = useMemo(
    () =>
      onlySelected && selectedIds.size > 0
        ? results.filter((r) => selectedIds.has(r.google_place_id))
        : results,
    [results, selectedIds, onlySelected],
  );

  const firmCols = MAPS_EXPORT_COLUMNS.filter((c) => c.group === "firm");
  const contactCols = MAPS_EXPORT_COLUMNS.filter((c) => c.group === "contact");

  const toggle = (key: string) =>
    setKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const download = () => {
    const orderedKeys = MAPS_EXPORT_COLUMNS.filter((c) => keys.has(c.key)).map((c) => c.key);
    const { headers, rows } = buildMapsCsvRows(places, orderedKeys);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`maps-export-${stamp}.csv`, toCsv(headers, rows));
    setOpen(false);
  };

  const column = (c: (typeof MAPS_EXPORT_COLUMNS)[number]) => (
    <label key={c.key} className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={keys.has(c.key)}
        onChange={() => toggle(c.key)}
        className="cursor-pointer"
      />
      {c.label}
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size="sm" variant="outline" className="cursor-pointer" />}
      >
        <Download size={14} className="mr-1.5" /> Download CSV
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Export columns</DialogTitle>
          <DialogDescription>
            Choose which columns to include. Domain is on by default.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Firm</p>
            <div className="space-y-1.5">{firmCols.map(column)}</div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Contact <span className="font-normal">(when available)</span>
            </p>
            <div className="space-y-1.5">{contactCols.map(column)}</div>
          </div>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {selectedIds.size > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={onlySelected}
                  onChange={(e) => setOnlySelected(e.target.checked)}
                  className="cursor-pointer"
                />
                Only selected ({selectedIds.size})
              </label>
            )}
            <span>
              {places.length} {places.length === 1 ? "business" : "businesses"}
            </span>
          </div>
          <div className="flex gap-2">
            <DialogClose render={<Button size="sm" variant="outline" className="cursor-pointer" />}>
              Cancel
            </DialogClose>
            <Button
              size="sm"
              onClick={download}
              disabled={keys.size === 0 || places.length === 0}
              className="cursor-pointer"
            >
              <Download size={14} className="mr-1.5" /> Download
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
