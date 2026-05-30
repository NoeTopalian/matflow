"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Plus,
  QrCode,
  ShieldAlert,
  UserRoundX,
  X,
} from "lucide-react";
import type { DayClass } from "@/components/dashboard/WeeklyCalendar";
import { filterTodoItems } from "@/lib/dashboard-todo";
import AddTaskModal, { type CreatedTask } from "@/components/dashboard/AddTaskModal";

export type UserTask = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  assignedTo: { id: string; name: string };
};

interface Props {
  stats: {
    totalActive: number;
    newThisMonth: number;
    attendanceThisWeek: number;
    attendanceThisMonth: number;
    waiverMissing: number;
    missingPhone: number;
    paymentsDue: number;
    atRiskMembers: number;
  };
  classes: DayClass[];
  tenantName: string;
  primaryColor: string;
  userName?: string;
  userTasks?: UserTask[];
  currentUserId?: string;
  currentUserRole?: string;
}

type TodoItem = {
  label: string;
  count: number;
  Icon: React.ElementType;
  color: string;
  href: string;
  action: string;
};


function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function todayKey() {
  return new Date().toISOString().split("T")[0];
}

function formatDate() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function classStatus(cls: DayClass) {
  if (!cls.coach || cls.coach === "TBC") return { label: "Needs coach", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" };
  if (cls.capacity && cls.enrolled >= cls.capacity) return { label: "Full", color: "#ef4444", bg: "rgba(239,68,68,0.12)" };
  return { label: "Ready", color: "#22c55e", bg: "rgba(34,197,94,0.12)" };
}

function MetricCard({
  label,
  value,
  detail,
  color,
  icon: Icon,
  href,
  onClick,
}: {
  label: string;
  value: string | number;
  detail: string;
  color: string;
  icon: React.ElementType;
  href?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] font-semibold" style={{ color: "var(--tx-4)" }}>
            {label}
          </p>
          <p className="text-2xl font-bold mt-2 leading-none" style={{ color: "var(--tx-1)" }}>
            {value}
          </p>
          <p className="text-xs mt-2" style={{ color: "var(--tx-3)" }}>
            {detail}
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(color, 0.14), color }}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
      {(href || onClick) && (
        <div className="mt-3 flex items-center gap-1 text-xs font-semibold" style={{ color }}>
          Open
          <ArrowRight className="w-3.5 h-3.5" />
        </div>
      )}
    </>
  );

  const className = "rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-white/20";
  const style = { background: "var(--sf-1)", borderColor: "var(--bd-default)" };

  if (href) {
    return (
      <Link href={href} className={className} style={style}>
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} style={style}>
        {content}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border p-4" style={style}>
      {content}
    </div>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const { label, count, Icon, color, href, action } = item;
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition-all hover:border-white/20"
      style={{ background: "rgba(255,255,255,0.018)", borderColor: "var(--bd-default)" }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: hex(color, 0.12), color }}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <span className="text-sm truncate block" style={{ color: "var(--tx-2)" }}>{label}</span>
          <span className="text-[11px]" style={{ color: "var(--tx-4)" }}>{action}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-sm font-semibold tabular-nums" style={{ color: count > 0 ? color : "var(--tx-3)" }}>
          {count}
        </span>
        <ArrowRight className="w-3.5 h-3.5" style={{ color: "var(--tx-4)" }} />
      </div>
    </Link>
  );
}

export default function DashboardStats({
  stats,
  classes,
  tenantName,
  primaryColor,
  userName,
  userTasks = [],
  currentUserId = "",
  currentUserRole = "",
}: Props) {
  const firstName = (userName ?? "").split(" ")[0] || "My";
  const todoListLabel = `${firstName}'s To Do List`;
  const [todoOpen, setTodoOpen] = useState(false);
  const [tasks, setTasks] = useState<UserTask[]>(userTasks);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [completing, setCompleting] = useState<string | null>(null);
  const myOpenTaskCount = tasks.filter((t) => t.assignedTo.id === currentUserId).length;

  function handleCreated(t: CreatedTask) {
    setTasks((prev) => [
      { id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, createdBy: t.createdBy, assignedTo: t.assignedTo },
      ...prev,
    ]);
  }

  async function handleComplete(taskId: string) {
    setCompleting(taskId);
    const prev = tasks;
    setTasks((cur) => cur.filter((t) => t.id !== taskId));
    try {
      const res = await fetch(`/api/tasks/${taskId}/complete`, { method: "POST" });
      if (!res.ok) setTasks(prev); // rollback
    } catch {
      setTasks(prev);
    } finally {
      setCompleting(null);
    }
  }
  const today = todayKey();
  const todayClasses = classes.filter((cls) => cls.date === today);
  const bookedToday = todayClasses.reduce((sum, cls) => sum + cls.enrolled, 0);
  const spacesLeft = todayClasses.reduce((sum, cls) => {
    if (!cls.capacity) return sum;
    return sum + Math.max(cls.capacity - cls.enrolled, 0);
  }, 0);
  const ownerTodoCount = stats.waiverMissing + stats.paymentsDue + stats.missingPhone + stats.atRiskMembers + myOpenTaskCount;

  const todoItems: TodoItem[] = [
    {
      label: "Missing waivers",
      count: stats.waiverMissing,
      Icon: ShieldAlert,
      color: "#f59e0b",
      href: "/dashboard/members?filter=waiver-missing",
      action: "Review waivers",
    },
    {
      label: "Overdue payments",
      count: stats.paymentsDue,
      Icon: CreditCard,
      color: "#ef4444",
      href: "/dashboard/members?filter=overdue",
      action: "Review payments",
    },
    {
      label: "Missing phone numbers",
      count: stats.missingPhone,
      Icon: UserRoundX,
      color: "#f59e0b",
      href: "/dashboard/members?filter=missing-phone",
      action: "Review details",
    },
    {
      label: "Members not seen in 14 days",
      count: stats.atRiskMembers,
      Icon: AlertTriangle,
      color: "#a78bfa",
      href: "/dashboard/members?filter=quiet",
      action: "Review members",
    },
  ];

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Today at {tenantName}
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            {formatDate()}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/dashboard/checkin"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium border transition-all hover:border-white/20 hover:text-white"
            style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
          >
            <QrCode className="w-3.5 h-3.5" />
            Check-In
          </Link>
          <Link
            href="/dashboard/timetable?new=class"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:opacity-90"
            style={{ background: primaryColor }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Class
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard label={todoListLabel} value={ownerTodoCount} detail="Tasks needing attention" color="#f59e0b" icon={ClipboardList} onClick={() => setTodoOpen(true)} />
        <MetricCard label="Payments Due" value={stats.paymentsDue} detail="Members to chase" color="#ef4444" icon={CreditCard} href="/dashboard/members?filter=overdue" />
        <MetricCard
          label="Today's Classes"
          value={todayClasses.length}
          detail={`${bookedToday} booked${spacesLeft > 0 ? ` · ${spacesLeft} spaces left` : ""}`}
          color={primaryColor}
          icon={CalendarCheck}
          href="/dashboard/coach"
        />
        <MetricCard label="At-Risk Members" value={stats.atRiskMembers} detail="Not seen in 14 days" color="#a78bfa" icon={AlertTriangle} href="/dashboard/members?filter=quiet" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-4">
        <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
          {/* Whole header area is a single clickable target — h2, subtitle, and
              the count badge all open the to-do drawer. Previously only the
              "{N} open" pill was clickable, leaving most of the header inert
              and discoverability poor. */}
          <button
            type="button"
            onClick={() => setTodoOpen(true)}
            className="w-full flex items-center justify-between mb-4 text-left transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20 rounded-lg"
            aria-label={`Open ${todoListLabel} (${ownerTodoCount} items)`}
          >
            <div>
              <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>{todoListLabel}</h2>
              <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>Items worth checking today</p>
            </div>
            <span
              className="text-xs font-semibold px-2 py-1 rounded-lg shrink-0"
              style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}
            >
              {ownerTodoCount} open
            </span>
          </button>
          <div className="space-y-2">
            {ownerTodoCount === 0 ? (
              <div className="rounded-xl border px-3 py-6 flex flex-col items-center gap-2 text-center" style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
                <CheckCircle2 className="w-6 h-6" style={{ color: "#22c55e" }} />
                <p className="text-sm">All caught up — nothing to action.</p>
              </div>
            ) : (
              filterTodoItems(todoItems).map((item) => <TodoRow key={item.label} item={item} />)
            )}
          </div>
        </div>

        <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>Today&apos;s Classes</h2>
              <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>Schedule and register readiness</p>
            </div>
            <Link href="/dashboard/coach" className="text-xs font-semibold hover:opacity-80" style={{ color: primaryColor }}>
              Open register
            </Link>
          </div>

          <div className="space-y-2">
            {todayClasses.length === 0 ? (
              <div className="rounded-xl border px-3 py-6 text-center" style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
                No classes scheduled today
              </div>
            ) : (
              todayClasses.slice(0, 5).map((cls) => {
                const status = classStatus(cls);
                return (
                  <Link
                    key={cls.id}
                    href={`/dashboard/checkin?class=${cls.id}`}
                    className="flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition-all hover:border-white/20"
                    style={{ background: "rgba(255,255,255,0.018)", borderColor: "var(--bd-default)" }}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>
                        {cls.time} · {cls.name}
                      </p>
                      <p className="text-xs mt-0.5 truncate" style={{ color: "var(--tx-3)" }}>
                        {cls.coach}{cls.location ? ` · ${cls.location}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs tabular-nums" style={{ color: "var(--tx-2)" }}>
                        {cls.enrolled}{cls.capacity ? ` / ${cls.capacity}` : ""}
                      </span>
                      <span className="text-[11px] font-semibold px-2 py-1 rounded-lg" style={{ background: status.bg, color: status.color }}>
                        {status.label}
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>

      {todoOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setTodoOpen(false)} />
          <aside
            className="fixed top-0 right-0 h-full w-full max-w-md z-50 flex flex-col border-l shadow-2xl"
            style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
            aria-label={todoListLabel}
          >
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
              <div>
                <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>{todoListLabel}</h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>{ownerTodoCount} items need attention</p>
              </div>
              <button
                type="button"
                onClick={() => setTodoOpen(false)}
                className="w-9 h-9 rounded-xl flex items-center justify-center border transition-colors hover:border-white/20"
                style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
                aria-label="Close to-do list"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {/* Add-task button — always available so any staff can send a task to a teammate. */}
              {currentUserId && (
                <button
                  type="button"
                  onClick={() => setAddTaskOpen(true)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-colors hover:border-white/20"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)", background: "var(--sf-1)" }}
                >
                  <Plus className="w-4 h-4" />
                  Add task for someone
                </button>
              )}

              {/* User-created tasks (this PR's headline feature). Mixed in with the auto-derived items below per the spec. */}
              {tasks.length > 0 && (
                <div className="space-y-2">
                  {tasks.map((task) => {
                    const isMine = task.assignedTo.id === currentUserId;
                    const canComplete = isMine || currentUserRole === "owner";
                    const otherName = isMine ? task.createdBy.name : task.assignedTo.name;
                    return (
                      <div
                        key={task.id}
                        className="rounded-2xl border p-4"
                        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                            style={{ background: hex(primaryColor, 0.13), color: primaryColor }}
                          >
                            <ClipboardList className="w-5 h-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold break-words" style={{ color: "var(--tx-1)" }}>{task.title}</h3>
                            <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
                              {isMine ? "From" : "Sent to"} {otherName}
                            </p>
                            {canComplete && (
                              <button
                                type="button"
                                onClick={() => handleComplete(task.id)}
                                disabled={completing === task.id}
                                className="mt-3 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                                style={{ background: "#22c55e" }}
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Mark done
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Auto-derived items + empty state */}
              {ownerTodoCount === 0 ? (
                <div className="rounded-2xl border p-6 flex flex-col items-center gap-2 text-center" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
                  <CheckCircle2 className="w-8 h-8" style={{ color: "#22c55e" }} />
                  <p className="text-sm">All caught up — nothing to action.</p>
                </div>
              ) : (
                filterTodoItems(todoItems).map(({ label, count, Icon, color, href, action }) => (
                  <div key={label} className="rounded-2xl border p-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(color, 0.13), color }}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{label}</h3>
                          <span className="text-sm font-bold tabular-nums" style={{ color }}>{count}</span>
                        </div>
                        <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
                          Open the filtered members list and deal with these records.
                        </p>
                        <Link
                          href={href}
                          onClick={() => setTodoOpen(false)}
                          className="mt-3 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                          style={{ background: color }}
                        >
                          {action}
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </>
      )}

      <AddTaskModal
        open={addTaskOpen}
        onClose={() => setAddTaskOpen(false)}
        onCreated={handleCreated}
        primaryColor={primaryColor}
        currentUserId={currentUserId}
      />
    </section>
  );
}
