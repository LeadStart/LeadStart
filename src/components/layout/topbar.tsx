"use client";

import { Ink } from "@/components/ui/ink";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Bell, Settings, LogOut, ChevronDown, User, MessageSquare, Mail, FileText, Menu } from "lucide-react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { GlobalSearch } from "@/components/layout/global-search";
import { NotificationsToggle } from "@/components/layout/notifications-toggle";
import { ViewAsToggle } from "@/components/layout/view-as-toggle";
import type { Notification } from "@/types/app";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppRole } from "@/types/app";

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function notificationIcon(type: string) {
  switch (type) {
    case "feedback": return <MessageSquare size={14} className="text-blue-500" />;
    case "webhook": return <Mail size={14} className="text-amber-500" />;
    case "report": return <FileText size={14} className="text-green-500" />;
    default: return <Bell size={14} className="text-primary" />;
  }
}

interface TopbarProps {
  userEmail: string;
  role: AppRole;
  /**
   * The viewer's real role, used to gate admin-only chrome (global search, the
   * notification bell). During a client-portal preview the shell passes
   * "client" here on purpose so that chrome disappears. See
   * src/lib/auth/view-as.ts.
   */
  actualRole?: AppRole;
  /**
   * True while an admin previews a client portal. Needed as its own flag
   * because `actualRole` reads "client" during a preview (that is what hides
   * the admin chrome), so the dropdown would otherwise have no way to know it
   * should offer the way back.
   */
  viewingAsClient?: boolean;
  onMenuClick?: () => void;
}

export function Topbar({ userEmail, role, actualRole, viewingAsClient = false, onMenuClick }: TopbarProps) {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const isAdmin = role === "owner" || role === "va";
  const isActualAdmin = actualRole === "owner" || actualRole === "va";
  const isBuyer = role === "buyer";
  const displayRole = isAdmin ? "Admin" : isBuyer ? "Buyer" : "Client";

  const { data: notifications, refetch: refetchNotifications } = useSupabaseQuery<Notification[]>(
    "notifications",
    async (supabase) => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as Notification[];
    }
  );

  const unreadCount = notifications?.filter((n) => !n.read).length ?? 0;

  async function handleMarkAllRead() {
    const supabase = createClient();
    const unreadIds = notifications?.filter((n) => !n.read).map((n) => n.id) ?? [];
    if (unreadIds.length === 0) return;
    await supabase
      .from("notifications")
      .update({ read: true })
      .in("id", unreadIds);
    refetchNotifications();
  }

  return (
    // Forge's top bar: a 52px white card with a hairline. `.app-topbar` (globals.css)
    // floats it beside the rail on desktop and as a stadium card on phones.
    <header className="app-topbar flex h-[52px] shrink-0 items-center justify-between gap-3 border border-border bg-card pr-2 pl-5 lg:pl-[18px]">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Brand wordmark: mobile/tablet only. Primary nav is the bottom tab
            bar now; the sidebar rail carries the brand at lg+. */}
        <span className="lg:hidden text-[13px] font-bold uppercase tracking-[0.2em] text-foreground">
          LeadStart
        </span>
        {/* Search bar: admin only, desktop only */}
        {isActualAdmin && <GlobalSearch />}
      </div>

      <div className="flex items-center gap-3">
        {/* Notification bell: admin only */}
        {isActualAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger className="relative flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted transition-colors outline-none cursor-pointer focus-visible:ring-3 focus-visible:ring-ring/35">
              <Bell size={18} />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-white">
                  {unreadCount}
                </span>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 max-h-96 overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-sm font-semibold text-foreground">Notifications</span>
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-xs text-primary hover:text-primary/80 font-medium cursor-pointer"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              <DropdownMenuSeparator />
              {(!notifications || notifications.length === 0) ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No notifications
                </div>
              ) : (
                notifications.map((n) => (
                  <DropdownMenuItem key={n.id} className="flex items-start gap-3 px-3 py-2.5 cursor-pointer">
                    <div className="mt-0.5 shrink-0">
                      {notificationIcon(n.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm leading-snug ${!n.read ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                        {n.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{timeAgo(n.created_at)}</p>
                    </div>
                    {!n.read && (
                      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Divider */}
        <div className="h-6 w-px bg-border" />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-tucked="the account's initials tucked into the round end (as far from the end as from the top); its name reads to the right"
            className="flex justify-start items-center gap-2.5 rounded-full py-1 pr-1 pl-1 sm:pr-3 transition-colors hover:bg-muted aria-expanded:bg-muted outline-none cursor-pointer focus-visible:ring-3 focus-visible:ring-ring/35"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary bg-(image:--tex-brand) text-xs font-bold text-white shrink-0">
              <Ink>{userEmail.charAt(0).toUpperCase()}</Ink>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-[13px] font-semibold text-foreground leading-none">{userEmail}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{displayRole}</p>
            </div>
            <ChevronDown size={14} className="text-muted-foreground hidden sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{userEmail}</p>
                  <p className="text-xs text-muted-foreground">{displayRole} Account</p>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {/* Overflow nav: mobile/tablet only. Opens the full sectioned drawer
                (Contacts, Reports, Mailboxes, Settings, …) that the bottom bar's
                five tabs don't cover. Hidden at lg where the rail shows it all. */}
            {onMenuClick && (
              <div className="lg:hidden">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={onMenuClick}>
                    <Menu size={14} className="mr-2" />
                    All sections
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </div>
            )}
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push(isAdmin ? "/admin/settings/team" : isBuyer ? "/buyer" : "/client/settings")}>
                <User size={14} className="mr-2" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(isActualAdmin ? "/admin/settings" : isBuyer ? "/buyer" : "/client/settings")}>
                <Settings size={14} className="mr-2" />
                Settings
              </DropdownMenuItem>
              {/* Web-push opt-in: renders nothing where push isn't supported */}
              <NotificationsToggle />
              {/* Two-way portal switch. Shown to real admins, and to anyone
                  already inside a preview so they can always get back out. */}
              {(isActualAdmin || viewingAsClient) && (
                <ViewAsToggle viewingAsClient={viewingAsClient} />
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={handleSignOut} variant="destructive">
                <LogOut size={14} className="mr-2" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
