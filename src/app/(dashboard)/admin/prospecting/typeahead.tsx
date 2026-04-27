"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Loader2,
  MapPin,
  Building2,
  Map as MapIcon,
  Tag,
} from "lucide-react";
import { Input } from "@/components/ui/input";

export interface TypeaheadResult {
  id: string;
  text: string;
  search_type?: "admin1" | "admin2" | "city";
  parent_admin1?: string;
}

interface Props {
  variant: "location" | "category";
  placeholder: string;
  value: string;
  onValueChange: (v: string) => void;
  onSelect: (item: TypeaheadResult) => void;
  onSearch: (term: string) => Promise<TypeaheadResult[]>;
  disabled?: boolean;
  id?: string;
}

const TYPE_BADGES = {
  admin1: {
    label: "State",
    color: "bg-blue-50 text-blue-700 border-blue-200",
    Icon: MapIcon,
  },
  admin2: {
    label: "County",
    color: "bg-amber-50 text-amber-700 border-amber-200",
    Icon: Building2,
  },
  city: {
    label: "City",
    color: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Icon: MapPin,
  },
} as const;

// Reusable typeahead. Mirrors the Replit reference's TypeaheadInput but
// drops framer-motion (LeadStart doesn't use it) and reads input value
// from the parent so the parent can clear it after selection.
export function Typeahead({
  variant,
  placeholder,
  value,
  onValueChange,
  onSelect,
  onSearch,
  disabled,
  id,
}: Props) {
  const [results, setResults] = useState<TypeaheadResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    async (term: string) => {
      if (term.trim().length < 2) {
        setResults([]);
        setIsOpen(false);
        return;
      }
      setIsLoading(true);
      try {
        const data = await onSearch(term.trim());
        setResults(data);
        setIsOpen(data.length > 0);
        setActiveIndex(-1);
      } catch {
        setResults([]);
        setIsOpen(false);
      } finally {
        setIsLoading(false);
      }
    },
    [onSearch],
  );

  function handleInputChange(v: string) {
    onValueChange(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(v), 300);
  }

  function handleSelect(item: TypeaheadResult) {
    onSelect(item);
    setResults([]);
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || results.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((p) => (p + 1) % results.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((p) => (p <= 0 ? results.length - 1 : p - 1));
        break;
      case "Enter":
        if (activeIndex >= 0 && activeIndex < results.length) {
          e.preventDefault();
          handleSelect(results[activeIndex]);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
          disabled={disabled}
          autoComplete="off"
          className="pr-9"
        />
        {isLoading && (
          <Loader2
            size={14}
            className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        )}
      </div>

      {isOpen && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-72 overflow-y-auto rounded-md border border-border bg-white shadow-lg">
          {results.map((item, i) => {
            const badge =
              variant === "location" && item.search_type
                ? TYPE_BADGES[item.search_type]
                : null;
            const BadgeIcon = badge?.Icon;
            const active = i === activeIndex;
            return (
              <button
                key={`${item.id}-${item.search_type ?? "cat"}-${i}`}
                type="button"
                onMouseDown={(e) => {
                  // mousedown so blur on input doesn't fire first and tear
                  // the dropdown down before the click registers.
                  e.preventDefault();
                  handleSelect(item);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors cursor-pointer ${
                  active ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {item.text}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">
                    {item.id}
                  </div>
                </div>
                {badge && BadgeIcon && (
                  <span
                    className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${badge.color}`}
                  >
                    <BadgeIcon size={11} />
                    {badge.label}
                  </span>
                )}
                {variant === "category" && (
                  <Tag
                    size={13}
                    className="text-muted-foreground shrink-0"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
