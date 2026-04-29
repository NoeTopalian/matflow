"use client";

import { useState, useEffect } from "react";
import { signOut } from "next-auth/react";
import { User, Mail, Phone, Bell, LogOut, Camera, Globe, ExternalLink, Plus, CheckCircle2, Circle, ChevronDown, ChevronUp, X } from "lucide-react";
import MemberBillingTab from "@/components/member/MemberBillingTab";
import ClassPacksWidget from "@/components/member/ClassPacksWidget";
import FamilySection from "@/components/member/FamilySection";

const PRIMARY    = "#3b82f6";

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

export default function MemberProfilePage() {
  const [notifications, setNotifications] = useState({
    classReminders: true,
    promotions: true,
    announcements: false,
  });
  const [gymName, setGymName]       = useState("Total BJJ");
  const [gymWebsite, setGymWebsite] = useState("https://totalbjj.co.uk");
  const [gymBilling, setGymBilling] = useState<{ memberSelfBilling: boolean; billingContactEmail: string | null; billingContactUrl: string | null; name: string }>({
    memberSelfBilling: false,
    billingContactEmail: null,
    billingContactUrl: null,
    name: "Total BJJ",
  });
  const [gymPrivacy, setGymPrivacy] = useState<{ privacyContactEmail: string | null; privacyPolicyUrl: string | null }>({
    privacyContactEmail: null,
    privacyPolicyUrl: null,
  });
  const [gymSocials, setGymSocials] = useState<{ instagramUrl: string | null; facebookUrl: string | null; tiktokUrl: string | null; youtubeUrl: string | null; twitterUrl: string | null; websiteUrl: string | null; logoUrl: string | null }>({
    instagramUrl: null,
    facebookUrl: null,
    tiktokUrl: null,
    youtubeUrl: null,
    twitterUrl: null,
    websiteUrl: null,
    logoUrl: null,
  });
  const [socialsOpen, setSocialsOpen] = useState(false);
  const [memberName, setMemberName] = useState("Alex Johnson");
  const [memberEmail, setMemberEmail] = useState("alex@example.com");
  const [memberPhone, setMemberPhone] = useState<string | null>(null);
  const [belt, setBelt] = useState({ name: "Blue Belt", color: "#3b82f6", stripes: 3 });
  const [membershipType, setMembershipType] = useState("Monthly Unlimited");
  const [memberSince, setMemberSince] = useState("September 2025");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const primaryColor = PRIMARY;

  function loadPageData() {
    setLoadError(null);

    // Fetch gym branding + billing + privacy + socials config (member-portal-only)
    fetch("/api/me/gym")
      .then((r) => r.ok ? r.json() : null)
      .then((data: {
        name?: string;
        logoUrl?: string | null;
        memberSelfBilling?: boolean;
        billingContactEmail?: string | null;
        billingContactUrl?: string | null;
        privacyContactEmail?: string | null;
        privacyPolicyUrl?: string | null;
        instagramUrl?: string | null;
        facebookUrl?: string | null;
        tiktokUrl?: string | null;
        youtubeUrl?: string | null;
        twitterUrl?: string | null;
        websiteUrl?: string | null;
      } | null) => {
        if (!data) return;
        if (data.name) setGymName(data.name);
        if (data.websiteUrl) setGymWebsite(data.websiteUrl);
        setGymBilling({
          memberSelfBilling: data.memberSelfBilling ?? false,
          billingContactEmail: data.billingContactEmail ?? null,
          billingContactUrl: data.billingContactUrl ?? null,
          name: data.name ?? "your gym",
        });
        setGymPrivacy({
          privacyContactEmail: data.privacyContactEmail ?? null,
          privacyPolicyUrl: data.privacyPolicyUrl ?? null,
        });
        setGymSocials({
          instagramUrl: data.instagramUrl ?? null,
          facebookUrl: data.facebookUrl ?? null,
          tiktokUrl: data.tiktokUrl ?? null,
          youtubeUrl: data.youtubeUrl ?? null,
          twitterUrl: data.twitterUrl ?? null,
          websiteUrl: data.websiteUrl ?? null,
          logoUrl: data.logoUrl ?? null,
        });
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));

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
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));
  }

  useEffect(() => {
    loadPageData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (k: keyof typeof notifications) =>
    setNotifications((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="px-4 pt-4 pb-8">
      <h1 className="text-white text-xl font-bold tracking-tight mb-4">Profile</h1>

      {/* Load error banner */}
      {loadError && (
        <div className="mb-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm flex-1">{loadError}</p>
          <button
            onClick={loadPageData}
            className="text-xs font-semibold px-3 py-1.5 rounded-xl shrink-0"
            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Club gym card — tap to open socials modal (Sprint 3 L) ── */}
      <button
        onClick={() => setSocialsOpen(true)}
        className="w-full flex items-center gap-3 rounded-2xl border p-4 mb-5 transition-all active:scale-[0.99] text-left"
        style={{ background: hex(primaryColor, 0.06), borderColor: hex(primaryColor, 0.2) }}
        aria-label={`Open ${gymName} links`}
      >
        {gymSocials.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={gymSocials.logoUrl} alt={`${gymName} logo`} className="w-9 h-9 rounded-xl object-cover shrink-0" />
        ) : (
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white font-bold text-sm"
            style={{ background: primaryColor }}
          >
            {gymName.charAt(0)}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold text-sm">{gymName}</p>
          <p className="text-gray-400 text-xs truncate">{(gymSocials.websiteUrl ?? gymWebsite).replace("https://", "")}</p>
        </div>
        <ExternalLink className="w-4 h-4 text-gray-500 shrink-0" />
      </button>

      {socialsOpen && (
        <GymSocialsModal
          gymName={gymName}
          logoUrl={gymSocials.logoUrl}
          socials={gymSocials}
          primaryColor={primaryColor}
          onClose={() => setSocialsOpen(false)}
        />
      )}

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

      {/* ── Billing + class packs ── */}
      <div className="space-y-4 mb-7">
        <MemberBillingTab primaryColor={primaryColor} gym={gymBilling} />
        <ClassPacksWidget primaryColor={primaryColor} />
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

      {/* ── My Family (parent account, real data) ── */}
      <FamilySection
        primaryColor={primaryColor}
        billingContactEmail={gymBilling.billingContactEmail}
        gymName={gymBilling.name}
      />

      {/* ── Personal details ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Personal Details
        </p>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <User className="w-4 h-4 text-gray-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Name</p>
            <input
              type="text"
              value={memberName}
              onChange={(e) => setMemberName(e.target.value)}
              className="w-full bg-transparent text-white text-sm outline-none"
              aria-label="Name"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderTop: "1px solid var(--member-border)" }}>
          <Mail className="w-4 h-4 text-gray-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Email</p>
            <input
              type="email"
              value={memberEmail}
              readOnly
              disabled
              className="w-full bg-transparent text-white text-sm outline-none"
              aria-label="Email"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderTop: "1px solid var(--member-border)" }}>
          <Phone className="w-4 h-4 text-gray-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-0.5">Phone</p>
            <input
              type="tel"
              value={memberPhone ?? ""}
              onChange={(e) => setMemberPhone(e.target.value || null)}
              className="w-full bg-transparent text-white text-sm outline-none"
              aria-label="Phone"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3 px-4 pb-4">
          <button
            onClick={async () => {
              setSaving(true);
              setSaveMsg(null);
              try {
                const res = await fetch("/api/member/me", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: memberName, phone: memberPhone }),
                });
                setSaveMsg(res.ok
                  ? { type: "ok", text: "Profile saved" }
                  : { type: "err", text: "Could not save. Try again." }
                );
                setTimeout(() => setSaveMsg(null), 3000);
              } catch {
                setSaveMsg({ type: "err", text: "Could not save. Try again." });
                setTimeout(() => setSaveMsg(null), 3000);
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saveMsg && (
            <span className={`text-sm font-medium ${saveMsg.type === "ok" ? "text-green-400" : "text-red-400"}`}>
              {saveMsg.text}
            </span>
          )}
        </div>
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

      {/* ── Data & Privacy (Sprint 3 L — authed-only, gym-specific) ── */}
      <div className="rounded-2xl border overflow-hidden mb-4" style={{ borderColor: "var(--member-border)" }}>
        <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider px-4 pt-4 pb-2">
          Data & Privacy
        </p>
        <div className="px-4 py-3.5 border-t border-white/5">
          <p className="text-gray-400 text-xs leading-relaxed">
            <span className="text-white font-medium">{gymName}</span> is the data controller for your account information, attendance records, and waivers held under MatFlow.
          </p>
          {(gymPrivacy.privacyContactEmail || gymPrivacy.privacyPolicyUrl) && (
            <div className="mt-3 space-y-1.5">
              {gymPrivacy.privacyContactEmail && (
                <a href={`mailto:${gymPrivacy.privacyContactEmail}`} className="flex items-center gap-2 text-xs" style={{ color: primaryColor }}>
                  <Mail className="w-3.5 h-3.5 shrink-0" /> {gymPrivacy.privacyContactEmail}
                </a>
              )}
              {gymPrivacy.privacyPolicyUrl && (
                <a href={gymPrivacy.privacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs" style={{ color: primaryColor }}>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" /> Read {gymName}&apos;s privacy notice
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Links ── */}
      <div className="rounded-2xl border overflow-hidden mb-6" style={{ borderColor: "var(--member-border)" }}>
        {[
          { label: "Privacy Policy",  href: gymPrivacy.privacyPolicyUrl ?? `${gymWebsite}/privacy` },
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

// ─── Sprint 3 L: Gym socials modal (client-side, not nav) ───────────────────

function GymSocialsModal({
  gymName,
  logoUrl,
  socials,
  primaryColor,
  onClose,
}: {
  gymName: string;
  logoUrl: string | null;
  socials: { instagramUrl: string | null; facebookUrl: string | null; tiktokUrl: string | null; youtubeUrl: string | null; twitterUrl: string | null; websiteUrl: string | null };
  primaryColor: string;
  onClose: () => void;
}) {
  const links = [
    { key: "websiteUrl", label: "Website",  url: socials.websiteUrl,  emoji: "🌐" },
    { key: "instagramUrl", label: "Instagram", url: socials.instagramUrl, emoji: "📸" },
    { key: "facebookUrl", label: "Facebook", url: socials.facebookUrl, emoji: "📘" },
    { key: "tiktokUrl", label: "TikTok",   url: socials.tiktokUrl,   emoji: "🎵" },
    { key: "youtubeUrl", label: "YouTube",  url: socials.youtubeUrl,  emoji: "▶️" },
    { key: "twitterUrl", label: "Twitter / X", url: socials.twitterUrl, emoji: "𝕏" },
  ].filter((l) => !!l.url);

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center"
        onClick={onClose}
        aria-modal="true"
        role="dialog"
      >
        <div
          className="bg-[var(--member-elevated)] border border-[var(--member-elevated-border)] rounded-t-3xl md:rounded-3xl w-full md:max-w-sm p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 mb-4">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={`${gymName} logo`} className="w-12 h-12 rounded-2xl object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white text-xl font-bold" style={{ background: primaryColor }}>
                {gymName.charAt(0)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-base">{gymName}</p>
              <p className="text-gray-500 text-xs">Connect with your gym</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: "var(--member-surface)" }}
              aria-label="Close"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          {links.length === 0 ? (
            <p className="text-gray-500 text-sm py-4">No links configured yet — ask your gym to add them in Settings.</p>
          ) : (
            <div className="space-y-2">
              {links.map((l) => (
                <a
                  key={l.key}
                  href={l.url ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-3 rounded-2xl transition-colors"
                  style={{ background: "var(--member-surface)", border: "1px solid var(--member-border)" }}
                >
                  <span className="text-lg">{l.emoji}</span>
                  <span className="flex-1 text-white text-sm font-medium">{l.label}</span>
                  <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
