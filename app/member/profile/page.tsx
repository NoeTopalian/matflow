"use client";

import { useState, useEffect } from "react";
import { signOut } from "next-auth/react";
import { User, Mail, Phone, Bell, LogOut, Camera, Globe, ExternalLink, Plus, CheckCircle2, Circle, ChevronDown, ChevronUp, X } from "lucide-react";

const PRIMARY    = "#3b82f6";

// ─── Children data ────────────────────────────────────────────────────────────

interface ChildProfile {
  id: string;
  name: string;
  age: number;
  belt: string;
  beltColor: string;
  stripes: number;
  classesThisMonth: number;
}

const DEMO_CHILDREN: ChildProfile[] = [
  { id: "c1", name: "Lily Johnson",  age: 9,  belt: "White", beltColor: "#e5e7eb", stripes: 2, classesThisMonth: 6 },
  { id: "c2", name: "Noah Johnson",  age: 7,  belt: "White", beltColor: "#e5e7eb", stripes: 0, classesThisMonth: 4 },
];

// ─── Journey data ─────────────────────────────────────────────────────────────

const MILESTONES = [
  { id: "1", type: "belt",        title: "White Belt",        date: "Sep 2025", emoji: "🤍", color: "#e5e7eb", detail: "First day on the mats" },
  { id: "2", type: "stripe",      title: "1st Stripe",        date: "Oct 2025", emoji: "⚡", color: "#f59e0b", detail: "Awarded by Coach Mike" },
  { id: "3", type: "stripe",      title: "2nd Stripe",        date: "Nov 2025", emoji: "⚡", color: "#f59e0b", detail: "Awarded by Coach Mike" },
  { id: "4", type: "competition", title: "First Competition",  date: "Dec 2025", emoji: "🏅", color: "#10b981", detail: "UKBJJA Nottingham Open — Bronze" },
  { id: "5", type: "belt",        title: "Blue Belt",          date: "Feb 2026", emoji: "🟦", color: "#3b82f6", detail: "Promoted by Coach Mike" },
  { id: "6", type: "stripe",      title: "1st Blue Stripe",   date: "Mar 2026", emoji: "⚡", color: "#f59e0b", detail: "Awarded by Coach Sarah" },
];

const BEGINNER_CARD = [
  { category: "Positions",    items: [
    { name: "Guard (closed)",   done: true },
    { name: "Half guard",       done: true },
    { name: "Side control",     done: true },
    { name: "Mount",            done: true },
    { name: "Back control",     done: true },
    { name: "North-South",      done: false },
  ]},
  { category: "Escapes",    items: [
    { name: "Upa bridge",       done: true },
    { name: "Elbow-knee escape",done: true },
    { name: "Guard replacement",done: true },
    { name: "Back escape",      done: false },
  ]},
  { category: "Submissions", items: [
    { name: "Rear naked choke", done: true },
    { name: "Triangle choke",   done: true },
    { name: "Armbar (guard)",   done: true },
    { name: "Americana",        done: true },
    { name: "Kimura",           done: false },
    { name: "Guillotine",       done: false },
  ]},
  { category: "Takedowns", items: [
    { name: "Double leg",       done: true },
    { name: "Single leg",       done: false },
    { name: "Foot sweep",       done: false },
  ]},
];

const DEMO_MEMBER = {
  name: "Alex Johnson",
  email: "alex.johnson@email.com",
  phone: "+44 7700 900123",
  membershipType: "Monthly Unlimited",
  memberSince: "September 2025",
  belt: "Blue Belt",
  beltColor: "#3b82f6",
  stripes: 3,
};

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

// ─── Beginner Card component ──────────────────────────────────────────────────

function BeginnerCard({ primaryColor }: { primaryColor: string }) {
  const [open, setOpen] = useState(false);

  const totalItems  = BEGINNER_CARD.flatMap((c) => c.items).length;
  const doneItems   = BEGINNER_CARD.flatMap((c) => c.items).filter((i) => i.done).length;

  return (
    <div className="rounded-2xl border overflow-hidden mb-5" style={{ borderColor: "var(--member-border)" }}>
      {/* Header — tap to expand */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-white/2"
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-lg" style={{ background: hex(primaryColor, 0.1) }}>
          🥋
        </div>
        <div className="flex-1">
          <p className="text-white font-semibold text-sm">Beginner Foundations</p>
          <p className="text-gray-500 text-xs mt-0.5">{doneItems} of {totalItems} techniques covered</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {open ? <ChevronUp className="w-4 h-4 text-gray-600" /> : <ChevronDown className="w-4 h-4 text-gray-600" />}
        </div>
      </button>

      {/* Expanded checklist */}
      {open && (
        <div className="border-t border-white/5 px-4 py-3 space-y-4">
          {BEGINNER_CARD.map((cat) => {
            const catDone = cat.items.filter((i) => i.done).length;
            return (
              <div key={cat.category}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">{cat.category}</p>
                  <span className="text-gray-600 text-xs">{catDone}/{cat.items.length}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {cat.items.map((item) => (
                    <div
                      key={item.name}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-xl"
                      style={{ background: item.done ? hex(primaryColor, 0.08) : "var(--member-surface)" }}
                    >
                      {item.done
                        ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: primaryColor }} />
                        : <Circle className="w-3.5 h-3.5 shrink-0 text-gray-700" />
                      }
                      <span
                        className="text-xs leading-tight"
                        style={{ color: item.done ? "var(--member-text)" : "var(--member-text-muted)" }}
                      >
                        {item.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <p className="text-gray-700 text-[10px] text-center pb-1">Updated by your coach · Last seen Mar 2026</p>
        </div>
      )}
    </div>
  );
}

// ─── Children Section ─────────────────────────────────────────────────────────

function ChildrenSection({ primaryColor }: { primaryColor: string }) {
  const [children, setChildren] = useState<ChildProfile[]>(DEMO_CHILDREN);
  const [adding, setAdding]     = useState(false);
  const [newName, setNewName]   = useState("");
  const [newAge, setNewAge]     = useState("");

  function addChild() {
    if (!newName.trim()) return;
    const child: ChildProfile = {
      id: `c${Date.now()}`,
      name: newName.trim(),
      age: parseInt(newAge) || 0,
      belt: "White",
      beltColor: "#e5e7eb",
      stripes: 0,
      classesThisMonth: 0,
    };
    setChildren((prev) => [...prev, child]);
    setNewName("");
    setNewAge("");
    setAdding(false);
  }

  function removeChild(id: string) {
    setChildren((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <div className="rounded-2xl border overflow-hidden mb-5" style={{ borderColor: "var(--member-border)" }}>
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div>
          <p className="text-white font-semibold text-sm">My Children</p>
          <p className="text-gray-500 text-xs mt-0.5">Track their progress and attendance</p>
        </div>
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-xl transition-all"
          style={{ background: hex(primaryColor, 0.12), color: primaryColor }}
        >
          <Plus className="w-3 h-3" />
          Add Child
        </button>
      </div>

      {/* Add child form */}
      {adding && (
        <div className="mx-4 mb-3 p-3 rounded-2xl space-y-2" style={{ background: "var(--member-surface)", border: "1px solid var(--member-border)" }}>
          <p className="text-gray-400 text-xs font-semibold mb-2">New child profile</p>
          <input
            type="text"
            placeholder="Child's name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none"
            style={{ borderColor: "var(--member-border)" }}
          />
          <input
            type="number"
            placeholder="Age"
            value={newAge}
            onChange={(e) => setNewAge(e.target.value)}
            className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none"
            style={{ borderColor: "var(--member-border)" }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setAdding(false)}
              className="flex-1 py-2.5 rounded-xl text-sm text-gray-500"
              style={{ background: "var(--member-surface)" }}
            >
              Cancel
            </button>
            <button
              onClick={addChild}
              disabled={!newName.trim()}
              className="flex-1 py-2.5 rounded-xl text-white font-semibold text-sm disabled:opacity-40"
              style={{ background: primaryColor }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Children list */}
      {children.length === 0 && !adding && (
        <div className="px-4 pb-4 text-center">
          <p className="text-gray-600 text-sm">No children added yet.</p>
          <p className="text-gray-700 text-xs mt-0.5">Tap &ldquo;Add Child&rdquo; to link a child&apos;s profile.</p>
        </div>
      )}

      {children.map((child, i) => (
        <div
          key={child.id}
          className="flex items-center gap-3 px-4 py-3.5"
          style={{ borderTop: i === 0 ? "1px solid var(--member-border)" : "1px solid var(--member-border)" }}
        >
          {/* Avatar */}
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ background: `linear-gradient(135deg, ${primaryColor}, ${hex(primaryColor, 0.6)})` }}
          >
            {child.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-white text-sm font-semibold truncate">{child.name}</p>
              {child.age > 0 && <span className="text-gray-600 text-xs shrink-0">Age {child.age}</span>}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <div className="w-5 h-2 rounded-sm" style={{ background: child.beltColor, border: "1px solid var(--member-text-dim)" }} />
              <span className="text-gray-500 text-xs">{child.belt} · {child.stripes} stripe{child.stripes !== 1 ? "s" : ""}</span>
              <span className="text-gray-600 text-xs">· {child.classesThisMonth} classes this month</span>
            </div>
          </div>

          {/* Remove */}
          <button
            onClick={() => removeChild(child.id)}
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-colors hover:bg-red-500/10"
            aria-label="Remove child"
          >
            <X className="w-3.5 h-3.5 text-gray-600 hover:text-red-400" />
          </button>
        </div>
      ))}

      <p className="text-gray-700 text-[10px] text-center px-4 pb-3 mt-1">Belt updates managed by your coach · Kids BJJ class enrolment in Schedule</p>
    </div>
  );
}

export default function MemberProfilePage() {
  const [notifications, setNotifications] = useState({
    classReminders: true,
    promotions: true,
    announcements: false,
  });
  const [gymName, setGymName]       = useState("Total BJJ");
  const [gymWebsite, setGymWebsite] = useState("https://totalbjj.co.uk");
  const [memberName, setMemberName] = useState("Alex Johnson");
  const [memberEmail, setMemberEmail] = useState("alex@example.com");
  const [memberPhone, setMemberPhone] = useState<string | null>(null);
  const [belt, setBelt] = useState({ name: "Blue Belt", color: "#3b82f6", stripes: 3 });
  const [membershipType, setMembershipType] = useState("Monthly Unlimited");
  const [memberSince, setMemberSince] = useState("September 2025");
  const primaryColor = PRIMARY;

  useEffect(() => {
    // Fetch gym branding
    fetch("/api/me/gym")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { name?: string } | null) => {
        if (data?.name) setGymName(data.name);
      })
      .catch(() => {});

    // Fetch member profile
    fetch("/api/member/me")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { name?: string; email?: string; phone?: string | null; belt?: { name: string; color: string; stripes: number } | null; membershipType?: string | null; joinedAt?: string } | null) => {
        if (data?.name)  setMemberName(data.name);
        if (data?.email) setMemberEmail(data.email);
        if (data?.phone !== undefined) setMemberPhone(data.phone ?? null);
        if (data?.belt) setBelt({ name: data.belt.name, color: data.belt.color, stripes: data.belt.stripes });
        if (data?.membershipType) setMembershipType(data.membershipType);
        if (data?.joinedAt) setMemberSince(new Date(data.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" }));
      })
      .catch(() => {});
  }, []);

  const toggle = (k: keyof typeof notifications) =>
    setNotifications((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="px-4 pt-4 pb-8">
      <h1 className="text-white text-xl font-bold tracking-tight mb-4">Profile</h1>

      {/* ── Club website banner ── */}
      <a
        href={gymWebsite}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-2xl border p-4 mb-5 transition-all active:scale-[0.99]"
        style={{ background: hex(primaryColor, 0.06), borderColor: hex(primaryColor, 0.2) }}
      >
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white font-bold text-sm"
          style={{ background: primaryColor }}
        >
          {gymName.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm">{gymName}</p>
          <p className="text-gray-400 text-xs truncate">{gymWebsite.replace("https://", "")}</p>
        </div>
        <ExternalLink className="w-4 h-4 text-gray-500 shrink-0" />
      </a>

      {/* ── Avatar ── */}
      <div className="flex flex-col items-center mb-7">
        <div className="relative">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-lg"
            style={{ background: `linear-gradient(135deg, ${primaryColor}, ${hex(primaryColor, 0.6)})` }}
          >
            {initials(memberName)}
          </div>
          <button
            className="absolute bottom-0 right-0 w-7 h-7 rounded-full flex items-center justify-center border-2"
            style={{ background: "var(--member-elevated)", borderColor: "var(--member-elevated-border)" }}
            aria-label="Change profile picture"
          >
            <Camera className="w-3.5 h-3.5 text-gray-400" />
          </button>
        </div>
        <p className="text-white font-semibold text-base mt-3">{memberName}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-8 h-3 rounded-sm" style={{ background: belt.color }} />
          <p className="text-gray-400 text-xs">{belt.name} · {belt.stripes} stripe{belt.stripes !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* ── My Journey ── */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold text-sm">My Journey</h2>
          <button
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-xl transition-all"
            style={{ background: hex(primaryColor, 0.12), color: primaryColor }}
          >
            <Plus className="w-3 h-3" />
            Add Photo
          </button>
        </div>

        {/* Horizontal milestone scroll */}
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
          {MILESTONES.map((m) => (
            <div
              key={m.id}
              className="flex-shrink-0 w-28 rounded-2xl border p-3 flex flex-col items-center text-center gap-1.5 transition-all active:scale-95 cursor-pointer"
              style={{ background: hex(m.color, 0.08), borderColor: hex(m.color, 0.25) }}
            >
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
                style={{ background: hex(m.color, 0.15) }}
              >
                {m.emoji}
              </div>
              <p className="text-white text-xs font-semibold leading-tight">{m.title}</p>
              <p className="text-gray-500 text-[10px]">{m.date}</p>
              <p className="text-gray-600 text-[9px] leading-tight">{m.detail}</p>
            </div>
          ))}

          {/* Add placeholder */}
          <div
            className="flex-shrink-0 w-28 rounded-2xl border border-dashed p-3 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all active:scale-95"
            style={{ borderColor: "var(--member-border)" }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "var(--member-surface)" }}>
              <Plus className="w-5 h-5 text-gray-600" />
            </div>
            <p className="text-gray-600 text-[10px] text-center leading-tight">Add milestone</p>
          </div>
        </div>
      </div>

      {/* ── Beginner Card ── */}
      <BeginnerCard primaryColor={primaryColor} />

      {/* ── My Children (parent account) ── */}
      <ChildrenSection primaryColor={primaryColor} />

      {/* ── Personal details ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Personal Details
        </p>
        {[
          { icon: User,  label: "Name",  value: memberName,          type: "text" },
          { icon: Mail,  label: "Email", value: memberEmail,         type: "email" },
          { icon: Phone, label: "Phone", value: memberPhone ?? "",   type: "tel" },
        ].map(({ icon: Icon, label, value, type }, i) => (
          <div
            key={label}
            className="flex items-center gap-3 px-4 py-3.5"
            style={{ borderTop: i > 0 ? "1px solid var(--member-border)" : undefined }}
          >
            <Icon className="w-4 h-4 text-gray-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">{label}</p>
              <input type={type} defaultValue={value} className="w-full bg-transparent text-white text-sm outline-none" aria-label={label} />
            </div>
          </div>
        ))}
      </div>

      {/* ── Membership ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Membership
        </p>
        <div className="px-4 py-3.5 flex items-center gap-3 border-t border-white/5">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: "#10b981" }} />
          <div className="flex-1">
            <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Current Plan</p>
            <p className="text-white text-sm">{membershipType}</p>
          </div>
          <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-400">Active</span>
        </div>
        <div className="px-4 py-3.5 flex items-center gap-3 border-t border-white/5">
          <Globe className="w-4 h-4 text-gray-600 shrink-0" />
          <div className="flex-1">
            <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Member Since</p>
            <p className="text-white text-sm">{memberSince}</p>
          </div>
        </div>
        {/* App Store compliant: direct to website, no in-app payment UI */}
        <a
          href={gymWebsite}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between px-4 py-3.5 border-t border-white/5 transition-colors hover:bg-white/3"
        >
          <span className="text-gray-400 text-sm">Manage subscription</span>
          <ExternalLink className="w-3.5 h-3.5 text-gray-600" />
        </a>
      </div>

      {/* ── Notifications ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Notifications
        </p>
        {[
          { key: "classReminders" as const, label: "Class reminders",   desc: "1 hour before subscribed classes" },
          { key: "promotions"     as const, label: "Belt promotions",   desc: "When you receive a stripe or belt" },
          { key: "announcements"  as const, label: "Gym announcements", desc: "News and updates from coaches" },
        ].map(({ key, label, desc }, i) => (
          <div
            key={key}
            className="flex items-center gap-3 px-4 py-3.5"
            style={{ borderTop: i > 0 ? "1px solid var(--member-border)" : undefined }}
          >
            <Bell className="w-4 h-4 text-gray-600 shrink-0" />
            <div className="flex-1">
              <p className="text-white text-sm font-medium">{label}</p>
              <p className="text-gray-500 text-xs">{desc}</p>
            </div>
            <button
              onClick={() => toggle(key)}
              className="relative w-10 h-6 rounded-full transition-all shrink-0"
              style={{ background: notifications[key] ? primaryColor : "var(--member-border)" }}
              role="switch"
              aria-checked={notifications[key]}
              aria-label={`Toggle ${label}`}
            >
              <span
                className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
                style={{ left: notifications[key] ? "calc(100% - 1.375rem)" : "0.125rem" }}
              />
            </button>
          </div>
        ))}
      </div>

      {/* ── Links ── */}
      <div className="rounded-2xl border overflow-hidden mb-6" style={{ borderColor: "var(--member-border)" }}>
        {[
          { label: "Privacy Policy",  href: `${gymWebsite}/privacy` },
          { label: "Terms of Service", href: `${gymWebsite}/terms` },
          { label: "Help & Support",  href: `${gymWebsite}/support` },
        ].map(({ label, href }, i) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between px-4 py-3.5 transition-colors hover:bg-white/3"
            style={{ borderTop: i > 0 ? "1px solid var(--member-border)" : undefined }}
          >
            <span className="text-gray-400 text-sm">{label}</span>
            <ExternalLink className="w-3.5 h-3.5 text-gray-600" />
          </a>
        ))}
      </div>

      {/* ── Sign out ── */}
      <button
        className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 text-sm font-semibold transition-all active:scale-[0.98]"
        style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}
        onClick={() => signOut({ callbackUrl: "/login" })}
      >
        <LogOut className="w-4 h-4" />
        Sign Out
      </button>
    </div>
  );
}
