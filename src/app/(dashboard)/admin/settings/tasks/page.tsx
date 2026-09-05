"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { ADMIN_TASKS_KEY, fetchAdminTasks } from "@/lib/admin-queries";
import { useSort } from "@/hooks/use-sort";
import { useUser } from "@/hooks/use-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { StatCard } from "@/components/charts/stat-card";
import { PaginationControls } from "@/components/ui/pagination-controls";
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
import { CheckSquare, ListTodo, Clock, CheckCircle2, Plus, Circle, Trash2, Pencil, Check, X } from "lucide-react";

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

const TASKS_PAGE_SIZE = 25;

export default function TasksPage() {
  const { user, organizationId } = useUser();
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

  // Inline edit state — which row is being edited + a working copy of its fields.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState<TaskStatus>("todo");
  const [editPriority, setEditPriority] = useState<TaskPriority>("medium");
  const [editCategory, setEditCategory] = useState("");
  const [editDueDate, setEditDueDate] = useState("");

  const { data, loading, refetch } = useSupabaseQuery(
    ADMIN_TASKS_KEY,
    fetchAdminTasks,
  );

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

  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [statusFilter, priorityFilter, categoryFilter, sortConfig?.key, sortConfig?.direction]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / TASKS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * TASKS_PAGE_SIZE;
  const pageRows = sorted.slice(pageStart, pageStart + TASKS_PAGE_SIZE);

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="grid grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div><div className="rounded-xl h-64 bg-muted/50" /></div>;

  async function handleAddTask() {
    if (!newTitle.trim()) return;
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const now = new Date().toISOString();
    const { error } = await supabase.from("tasks").insert({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      created_by: user?.id ?? null,
      title: newTitle.trim(),
      description: newDescription.trim() || null,
      priority: newPriority,
      category: newCategory.trim() || null,
      due_date: newDueDate || null,
      status: "todo" as TaskStatus,
      created_at: now,
      updated_at: now,
    });
    setSaving(false);
    if (error) {
      alert(`Failed to add task: ${error.message}`);
      return;
    }
    setNewTitle("");
    setNewDescription("");
    setNewPriority("medium");
    setNewCategory("");
    setNewDueDate("");
    setShowAddForm(false);
    refetch();
  }

  async function handleToggleStatus(task: Task) {
    const supabase = createClient();
    const nextStatus = NEXT_STATUS[task.status];
    const { error } = await supabase.from("tasks").update({ status: nextStatus }).eq("id", task.id);
    if (error) {
      alert(`Failed to update task: ${error.message}`);
      return;
    }
    refetch();
  }

  async function handleDeleteTask(task: Task) {
    if (!confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
    const supabase = createClient();
    const { error } = await supabase.from("tasks").delete().eq("id", task.id);
    if (error) {
      alert(`Failed to delete task: ${error.message}`);
      return;
    }
    refetch();
  }

  function handleStartEdit(task: Task) {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditStatus(task.status);
    setEditPriority(task.priority);
    setEditCategory(task.category ?? "");
    // due_date may come back as a full timestamp; the date input wants YYYY-MM-DD.
    setEditDueDate(task.due_date ? task.due_date.slice(0, 10) : "");
    // Don't leave the add form open behind the edit row.
    setShowAddForm(false);
  }

  function handleCancelEdit() {
    setEditingId(null);
  }

  async function handleSaveEdit() {
    if (!editingId || !editTitle.trim()) return;
    setSavingEdit(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("tasks")
      .update({
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        status: editStatus,
        priority: editPriority,
        category: editCategory.trim() || null,
        due_date: editDueDate || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", editingId);
    setSavingEdit(false);
    if (error) {
      alert(`Failed to update task: ${error.message}`);
      return;
    }
    setEditingId(null);
    refetch();
  }

  // Enter saves, Escape cancels — for a quick keyboard-driven inline edit.
  function handleEditKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSaveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelEdit();
    }
  }

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Total Tasks" value={total} icon={<CheckSquare size={18} className="text-purple-500" />} iconBg="bg-purple-50" />
        <StatCard label="To Do" value={todoCount} icon={<ListTodo size={18} className="text-gray-500" />} iconBg="bg-background" />
        <StatCard label="In Progress" value={inProgressCount} icon={<Clock size={18} className="text-blue-500" />} iconBg="bg-blue-50" valueColor="text-blue-600" />
        <StatCard label="Done" value={doneCount} icon={<CheckCircle2 size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
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

        <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v ?? "all")}>
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

        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? "all")}>
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
                  <TableHead className="w-[88px] text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((task) => {
                  const isEditing = editingId === task.id;
                  return (
                  <TableRow key={task.id} className={isEditing ? "bg-purple-50/50" : undefined}>
                    {/* Title (+ description) */}
                    <TableCell className="align-top">
                      {isEditing ? (
                        <div className="max-w-[380px] min-w-[180px] space-y-1.5">
                          <Input
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            placeholder="Task title"
                            autoFocus
                            style={{ height: "32px" }}
                            className="text-sm"
                          />
                          <Textarea
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            placeholder="Optional description"
                            rows={2}
                            className="text-xs"
                          />
                        </div>
                      ) : (
                        <div className="max-w-[380px] min-w-[160px]">
                          <p className="font-medium break-words">{task.title}</p>
                          {task.description && (
                            <p className="mt-0.5 text-xs text-muted-foreground whitespace-normal break-words">
                              {task.description}
                            </p>
                          )}
                        </div>
                      )}
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      {isEditing ? (
                        <Select value={editStatus} onValueChange={(v) => setEditStatus(v as TaskStatus)}>
                          <SelectTrigger className="w-[140px]" style={{ height: "32px" }}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="todo">To Do</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="done">Done</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
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
                      )}
                    </TableCell>

                    {/* Priority */}
                    <TableCell>
                      {isEditing ? (
                        <Select value={editPriority} onValueChange={(v) => setEditPriority(v as TaskPriority)}>
                          <SelectTrigger className="w-[120px]" style={{ height: "32px" }}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary" className={PRIORITY_COLORS[task.priority]}>
                          {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                        </Badge>
                      )}
                    </TableCell>

                    {/* Category */}
                    <TableCell className="text-sm text-muted-foreground">
                      {isEditing ? (
                        <Input
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                          onKeyDown={handleEditKeyDown}
                          placeholder="Category"
                          style={{ height: "32px" }}
                          className="w-[150px] text-sm"
                        />
                      ) : (
                        task.category || "—"
                      )}
                    </TableCell>

                    {/* Due date */}
                    <TableCell className="text-sm text-muted-foreground">
                      {isEditing ? (
                        <Input
                          type="date"
                          value={editDueDate}
                          onChange={(e) => setEditDueDate(e.target.value)}
                          onKeyDown={handleEditKeyDown}
                          style={{ height: "32px" }}
                          className="w-[160px] text-sm"
                        />
                      ) : task.due_date ? (
                        new Date(task.due_date).toLocaleDateString()
                      ) : (
                        "—"
                      )}
                    </TableCell>

                    {/* Created (read-only) */}
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(task.created_at).toLocaleDateString()}
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={handleSaveEdit}
                            disabled={savingEdit || !editTitle.trim()}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-emerald-600 hover:bg-emerald-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Save changes"
                          >
                            <Check size={15} />
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            disabled={savingEdit}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
                            title="Cancel"
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleStartEdit(task)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-blue-50 hover:text-blue-600 transition-colors cursor-pointer"
                            title="Edit task"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => handleDeleteTask(task)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors cursor-pointer"
                            title="Delete task"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <PaginationControls
            currentPage={safePage}
            totalItems={sorted.length}
            pageSize={TASKS_PAGE_SIZE}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
