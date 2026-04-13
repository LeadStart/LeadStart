"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { StatCard } from "@/components/charts/stat-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { CheckSquare, ListTodo, Clock, CheckCircle2, Plus, Circle } from "lucide-react";

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";
export interface Task {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string | null;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  todo: "bg-[#e2e8f0] text-[#7A7872] border-gray-200",
  in_progress: "badge-blue",
  done: "badge-green",
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "bg-gray-100 text-gray-500",
  medium: "badge-amber",
  high: "badge-red",
};

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add form state
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<TaskPriority>("medium");
  const [newCategory, setNewCategory] = useState("");
  const [newDueDate, setNewDueDate] = useState("");

  const { data, loading, refetch } = useSupabaseQuery("admin-tasks", async (supabase) => {
    const res = await supabase.from("tasks").select("*").order("created_at", { ascending: false });
    return (res.data || []) as Task[];
  });

  const tasks = data || [];
  const total = tasks.length;
  const todoCount = tasks.filter(t => t.status === "todo").length;
  const inProgressCount = tasks.filter(t => t.status === "in_progress").length;
  const doneCount = tasks.filter(t => t.status === "done").length;

  const categories = Array.from(new Set(tasks.map(t => t.category).filter(Boolean))) as string[];

  const filtered = tasks.filter(t => {
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
    if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
    return true;
  });

  const { sorted, sortConfig, requestSort } = useSort(filtered);

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="grid grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div><div className="rounded-xl h-64 bg-muted/50" /></div>;

  async function handleAddTask() {
    if (!newTitle.trim()) return;
    setSaving(true);
    const supabase = createClient();
    await supabase.from("tasks").insert({
      title: newTitle.trim(),
      description: newDescription.trim() || null,
      priority: newPriority,
      category: newCategory.trim() || null,
      due_date: newDueDate || null,
      status: "todo" as TaskStatus,
    });
    setNewTitle("");
    setNewDescription("");
    setNewPriority("medium");
    setNewCategory("");
    setNewDueDate("");
    setShowAddForm(false);
    setSaving(false);
    refetch();
  }

  async function handleToggleStatus(task: Task) {
    const supabase = createClient();
    const nextStatus = NEXT_STATUS[task.status];
    await supabase.from("tasks").update({ status: nextStatus }).eq("id", task.id);
    refetch();
  }

  return (
    <div className="space-y-6">
      {/* Gradient header banner */}
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Internal Tracker</p>
          <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Tasks</h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">{total} total tasks across all categories</p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Total Tasks" value={total} icon={<CheckSquare size={18} className="text-purple-500" />} iconBg="bg-purple-50" />
        <StatCard label="To Do" value={todoCount} icon={<ListTodo size={18} className="text-gray-500" />} iconBg="bg-background" />
        <StatCard label="In Progress" value={inProgressCount} icon={<Clock size={18} className="text-blue-500" />} iconBg="bg-blue-50" valueColor="text-blue-600" />
        <StatCard label="Done" value={doneCount} icon={<CheckCircle2 size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]" style={{ height: '36px' }}>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="todo">To Do</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="done">Done</SelectItem>
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="w-[150px]" style={{ height: '36px' }}>
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Priorities</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>

        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[150px]" style={{ height: '36px' }}>
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map(cat => (
              <SelectItem key={cat} value={cat}>{cat}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" onClick={() => setShowAddForm(!showAddForm)} className="ml-auto">
          <Plus size={16} className="mr-1" />
          Add Task
        </Button>
      </div>

      {/* Inline add task form */}
      {showAddForm && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50">
              <Plus size={16} className="text-purple-500" />
            </div>
            <CardTitle className="text-base">New Task</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="task-title">Title *</Label>
                <Input
                  id="task-title"
                  placeholder="Task title"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  style={{ height: '36px' }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-category">Category</Label>
                <Input
                  id="task-category"
                  placeholder="e.g. Frontend, Backend, Design"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  style={{ height: '36px' }}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-description">Description</Label>
              <Textarea
                id="task-description"
                placeholder="Optional description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={newPriority} onValueChange={(v) => setNewPriority(v as TaskPriority)}>
                  <SelectTrigger style={{ height: '36px' }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-due-date">Due Date</Label>
                <Input
                  id="task-due-date"
                  type="date"
                  value={newDueDate}
                  onChange={(e) => setNewDueDate(e.target.value)}
                  style={{ height: '36px' }}
                />
              </div>
              <div className="flex items-end gap-2">
                <Button onClick={handleAddTask} disabled={saving || !newTitle.trim()} className="flex-1">
                  {saving ? "Saving..." : "Add Task"}
                </Button>
                <Button variant="outline" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tasks table */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50">
          <CheckSquare size={16} className="text-purple-500" />
        </div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">All Tasks</h2>
        <span className="text-sm text-muted-foreground ml-auto">{filtered.length} task{filtered.length !== 1 ? "s" : ""}</span>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="title" sortConfig={sortConfig} onSort={requestSort}>Title</SortableHead>
                  <SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>Status</SortableHead>
                  <SortableHead sortKey="priority" sortConfig={sortConfig} onSort={requestSort}>Priority</SortableHead>
                  <SortableHead sortKey="category" sortConfig={sortConfig} onSort={requestSort}>Category</SortableHead>
                  <SortableHead sortKey="due_date" sortConfig={sortConfig} onSort={requestSort}>Due Date</SortableHead>
                  <SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>Created</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <p className="font-medium">{task.title}</p>
                      {task.description && <p className="text-xs text-muted-foreground line-clamp-1">{task.description}</p>}
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => handleToggleStatus(task)}
                        className="inline-flex items-center gap-1.5 cursor-pointer group"
                        title={`Click to change to "${STATUS_LABELS[NEXT_STATUS[task.status]]}"`}
                      >
                        <Badge variant="secondary" className={`border ${STATUS_COLORS[task.status]} group-hover:opacity-80 transition-opacity`}>
                          {task.status === "todo" && <Circle size={12} className="mr-1" />}
                          {task.status === "in_progress" && <Clock size={12} className="mr-1" />}
                          {task.status === "done" && <CheckCircle2 size={12} className="mr-1" />}
                          {STATUS_LABELS[task.status]}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={PRIORITY_COLORS[task.priority]}>
                        {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{task.category || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task.due_date ? new Date(task.due_date).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(task.created_at).toLocaleDateString()}
                    </TableCell>
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
