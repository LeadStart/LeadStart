"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Bell, Search, ArrowLeftRight, Settings, LogOut, ChevronDown, User, MessageSquare, Mail, FileText } from "lucide-react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
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
    default: return <Bell size={14} className="text-indigo-500" />;
  }
}

interface TopbarProps {
  userEmail: string;
  role: AppRole;
  actualRole?: AppRole;
  onRoleSwitch: (role: AppRole) => void;
}

export function Topbar({ userEmail, role, actualRole, onRoleSwitch }: TopbarProps) {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const isAdmin = role === "owner" || role === "va";
  const isActualAdmin = actualRole === "owner" || actualRole === "va";
  const displayRole = isAdmin ? "Admin" : "Client";
  const switchToRole: AppRole = isAdmin ? "client" : "owner";
  const switchLabel = isAdmin ? "Client View" : "Admin View";

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
    <header className="flex h-16 items-center justify-between border-b border-border/50 bg-white px-6">
      {/* Search bar — admin only */}
      {isActualAdmin ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground w-72">
          <Search size={14} />
          <span>Search campaigns, clients...</span>
        </div>
      ) : (
        <div />
      )}

      <div className="flex items-center gap-3">
        {/* Role Switcher — only for admins */}
        {isActualAdmin && (
          <button
            onClick={() => onRoleSwitch(switchToRole)}
            className="flex items-center gap-2 rounded-lg border border-dashed border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition-all hover:bg-indigo-100 hover:border-indigo-400"
          >
            <ArrowLeftRight size={13} />
            Switch to {switchLabel}
          </button>
        )}

        {/* Notification bell — admin only */}
        {isActualAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors outline-none cursor-pointer">
              <Bell size={18} />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
                  {unreadCount}
                </span>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 max-h-96 overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-2">
                <DropdownMenuLabel className="p-0 text-sm font-semibold">Notifications</DropdownMenuLabel>
                {unreadCount > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
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
                      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-500" />
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
            <div className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold text-white shrink-0" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed)' }}>
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
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push(isAdmin ? "/admin/settings/team" : "/client")}>
                <User size={14} className="mr-2" />
                Profile
              </DropdownMenuItem>
              {isActualAdmin && (
                <DropdownMenuItem onClick={() => router.push("/admin/settings/api")}>
                  <Settings size={14} className="mr-2" />
                  Settings
                </DropdownMenuItem>
              )}
              {isActualAdmin && (
                <DropdownMenuItem onClick={() => onRoleSwitch(switchToRole)}>
                  <ArrowLeftRight size={14} className="mr-2" />
                  Switch to {switchLabel}
                </DropdownMenuItem>
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
