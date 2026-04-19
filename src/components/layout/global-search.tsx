"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Users, Mail, UserSquare2 } from "lucide-react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import type { Client, Campaign, Contact } from "@/types/app";

type ResultKind = "client" | "campaign" | "contact";

interface SearchResult {
  kind: ResultKind;
  id: string;
  label: string;
  sublabel?: string;
  href: string;
}

const MAX_PER_GROUP = 5;

export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data } = useSupabaseQuery("topbar-global-search", async (supabase) => {
    const [clientsRes, campaignsRes, contactsRes] = await Promise.all([
      supabase.from("clients").select("id, name, contact_email"),
      supabase.from("campaigns").select("id, name, client_id, status"),
      supabase
        .from("contacts")
        .select("id, first_name, last_name, email, company_name"),
    ]);
    return {
      clients: (clientsRes.data || []) as Pick<
        Client,
        "id" | "name" | "contact_email"
      >[],
      campaigns: (campaignsRes.data || []) as Pick<
        Campaign,
        "id" | "name" | "client_id" | "status"
      >[],
      contacts: (contactsRes.data || []) as Pick<
        Contact,
        "id" | "first_name" | "last_name" | "email" | "company_name"
      >[],
    };
  });

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];

    const clientResults: SearchResult[] = data.clients
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.contact_email || "").toLowerCase().includes(q),
      )
      .slice(0, MAX_PER_GROUP)
      .map((c) => ({
        kind: "client",
        id: c.id,
        label: c.name,
        sublabel: c.contact_email || undefined,
        href: `/admin/clients/${c.id}`,
      }));

    const clientNameById = new Map(data.clients.map((c) => [c.id, c.name]));
    const campaignResults: SearchResult[] = data.campaigns
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, MAX_PER_GROUP)
      .map((c) => ({
        kind: "campaign",
        id: c.id,
        label: c.name,
        sublabel: clientNameById.get(c.client_id) || undefined,
        href: `/admin/clients/${c.client_id}/campaigns/${c.id}`,
      }));

    const contactResults: SearchResult[] = data.contacts
      .filter((c) => {
        const name = `${c.first_name || ""} ${c.last_name || ""}`.toLowerCase();
        return (
          name.includes(q) ||
          c.email.toLowerCase().includes(q) ||
          (c.company_name || "").toLowerCase().includes(q)
        );
      })
      .slice(0, MAX_PER_GROUP)
      .map((c) => {
        const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ");
        return {
          kind: "contact",
          id: c.id,
          label: fullName || c.email,
          sublabel: fullName
            ? `${c.email}${c.company_name ? ` · ${c.company_name}` : ""}`
            : c.company_name || undefined,
          href: `/admin/contacts?q=${encodeURIComponent(c.email)}`,
        };
      });

    return [...clientResults, ...campaignResults, ...contactResults];
  }, [query, data]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function navigateTo(result: SearchResult) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(result.href);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      const r = results[highlight];
      if (r) {
        e.preventDefault();
        navigateTo(r);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  const showDropdown = open && query.trim().length > 0;

  const clientResults = results.filter((r) => r.kind === "client");
  const campaignResults = results.filter((r) => r.kind === "campaign");
  const contactResults = results.filter((r) => r.kind === "contact");

  return (
    <div ref={containerRef} className="relative hidden md:block w-72">
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-[#f8fafc] px-3 py-2 text-sm focus-within:border-[#2E37FE]/40 focus-within:bg-white focus-within:ring-3 focus-within:ring-[#2E37FE]/10 transition-colors">
        <Search size={14} className="text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length > 0) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search campaigns, clients..."
          aria-label="Search"
          className="w-full bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1.5 rounded-lg border border-border/50 bg-white shadow-lg max-h-96 overflow-y-auto z-50">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            <>
              {clientResults.length > 0 && (
                <ResultGroup
                  title="Clients"
                  icon={<Users size={12} />}
                  results={clientResults}
                  startIndex={0}
                  highlight={highlight}
                  onSelect={navigateTo}
                />
              )}
              {campaignResults.length > 0 && (
                <ResultGroup
                  title="Campaigns"
                  icon={<Mail size={12} />}
                  results={campaignResults}
                  startIndex={clientResults.length}
                  highlight={highlight}
                  onSelect={navigateTo}
                />
              )}
              {contactResults.length > 0 && (
                <ResultGroup
                  title="Contacts"
                  icon={<UserSquare2 size={12} />}
                  results={contactResults}
                  startIndex={clientResults.length + campaignResults.length}
                  highlight={highlight}
                  onSelect={navigateTo}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface ResultGroupProps {
  title: string;
  icon: React.ReactNode;
  results: SearchResult[];
  startIndex: number;
  highlight: number;
  onSelect: (r: SearchResult) => void;
}

function ResultGroup({
  title,
  icon,
  results,
  startIndex,
  highlight,
  onSelect,
}: ResultGroupProps) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </div>
      {results.map((r, i) => {
        const absoluteIndex = startIndex + i;
        const active = absoluteIndex === highlight;
        return (
          <button
            key={`${r.kind}-${r.id}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(r)}
            className={`w-full flex items-start gap-2 px-3 py-1.5 text-left text-sm cursor-pointer transition-colors ${
              active ? "bg-[#f1f2ff]" : "hover:bg-[#f8fafc]"
            }`}
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-foreground truncate">{r.label}</p>
              {r.sublabel && (
                <p className="text-xs text-muted-foreground truncate">
                  {r.sublabel}
                </p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
