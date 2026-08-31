"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Bell, Settings, LogOut, ChevronDown, User, MessageSquare, Mail, FileText, Menu } from "lucide-react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { GlobalSearch } from "@/components/layout/global-search";
import { NotificationsToggle } from "@/components/layout/notifications-toggle";
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
  actualRole?: AppRole;
  onRoleSwitch: (role: AppRole) => void;
  onMenuClick?: () => void;
}

export function Topbar({ userEmail, role, actualRole, onRoleSwitch, onMenuClick }: TopbarProps) {
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
    // Mobile: flush full-width strip with a border-b. Desktop (lg): `.app-topbar`
    // (globals.css) floats it as an inset, rounded, hairline card matching the rail.
    <header className="app-topbar flex h-16 shrink-0 items-center justify-between border-b border-border/50 bg-white px-4 sm:px-6 gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Brand wordmark — mobile/tablet only. Primary nav is the bottom tab
            bar now; the sidebar rail carries the brand at lg+. */}
        <span className="lg:hidden text-[15px] font-semibold tracking-tight text-foreground">
          LeadStart
        </span>
        {/* Search bar — admin only, desktop only */}
        {isActualAdmin && <GlobalSearch />}
      </div>

      <div className="flex items-center gap-3">
        {/* Notification bell — admin only */}
        {isActualAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors outline-none cursor-pointer">
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
        <div className="h-8 w-px bg-border/50" />

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50 outline-none cursor-pointer">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-white shrink-0">
              {userEmail.charAt(0).toUpperCase()}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-foreground leading-none">{userEmail}</p>
              <p className="text-[11px] text-muted-foreground">{displayRole}</p>
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
            {/* Overflow nav — mobile/tablet only. Opens the full sectioned drawer
                (Contacts, Reports, Mailboxes, Billing, …) that the bottom bar's
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
              <DropdownMenuItem onClick={() => router.push(isActualAdmin ? "/admin/settings/api" : isBuyer ? "/buyer" : "/client/settings")}>
                <Settings size={14} className="mr-2" />
                Settings
              </DropdownMenuItem>
              {/* Web-push opt-in — renders nothing where push isn't supported */}
              <NotificationsToggle />
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
