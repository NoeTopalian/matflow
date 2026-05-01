"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  Settings, Users, Palette, Shield, Plus, Trash2,
  Edit2, X, Loader2, Copy, Check, ExternalLink,
  Crown, User, ChevronRight, UploadCloud, ShoppingBag,
  DollarSign, TrendingUp, Package, LayoutDashboard, Bell,
  Home, Calendar, FileText, Cable,
} from "lucide-react";
import IntegrationsTab from "@/components/dashboard/IntegrationsTab";
import PaymentsTable from "@/components/dashboard/PaymentsTable";
import ClassPacksManager from "@/components/dashboard/ClassPacksManager";
import { useToast } from "@/components/ui/Toast";
import type { TenantSettings, StaffMember } from "@/app/dashboard/settings/page";

interface Props {
  settings: TenantSettings | null;
  staff: StaffMember[];
  statusCounts: Record<string, number>;
  primaryColor: string;
  role: string;
  currentUserId: string;
  totpEnabled?: boolean;
  stripeConnected?: boolean;
  stripeAccountId?: string | null;
}

type Tab = "overview" | "branding" | "revenue" | "store" | "staff" | "account" | "waiver" | "integrations";

const TAB_IDS: Tab[] = ["overview", "branding", "revenue", "store", "staff", "account", "waiver", "integrations"];

function isTab(value: string | null): value is Tab {
  return !!value && TAB_IDS.includes(value as Tab);
}

interface StoreProduct {
  id: string;
  name: string;
  price: number;
  category: "clothing" | "food" | "drink" | "equipment" | "other";
  inStock: boolean;
  emoji: string;
}

interface ThemePreset {
  name: string;
  style: string;  // short descriptor shown in pill
  primary: string;
  secondary: string;
  text: string;
  bg: string;      // member app background
  font: string;    // CSS font-family value
  fontLabel: string;
  mode: "dark" | "light";
}

const THEME_PRESETS: ThemePreset[] = [
  // ── Dark themes ────────────────────────────────────────────────────────────
  { name: "Classic BJJ",    style: "Dark · Pro",       primary: "#3b82f6", secondary: "#1d4ed8", text: "#ffffff", bg: "#111111", font: "'Inter', sans-serif",                                fontLabel: "Inter",           mode: "dark" },
  { name: "Dojo Black",     style: "Dark · Prestige",  primary: "#d97706", secondary: "#92400e", text: "#ffffff", bg: "#0a0a0a", font: "'Montserrat', sans-serif",                            fontLabel: "Montserrat",      mode: "dark" },
  { name: "Fight Night",    style: "Dark · Energy",    primary: "#ef4444", secondary: "#f97316", text: "#ffffff", bg: "#0d0d0d", font: "'Oswald', sans-serif",                                fontLabel: "Oswald",          mode: "dark" },
  { name: "Purple Reign",   style: "Dark · Elite",     primary: "#7c3aed", secondary: "#6d28d9", text: "#ffffff", bg: "#0f0a1a", font: "'Plus Jakarta Sans', sans-serif",                    fontLabel: "Plus Jakarta Sans", mode: "dark" },
  { name: "Forest Warrior", style: "Dark · Natural",   primary: "#16a34a", secondary: "#15803d", text: "#ffffff", bg: "#080f0a", font: "'Barlow', sans-serif",                                fontLabel: "Barlow",          mode: "dark" },
  { name: "Cyber",          style: "Dark · Tech",      primary: "#06b6d4", secondary: "#0891b2", text: "#ffffff", bg: "#050d12", font: "'Space Grotesk', sans-serif",                        fontLabel: "Space Grotesk",   mode: "dark" },
  { name: "Midnight",       style: "Dark · Minimal",   primary: "#6366f1", secondary: "#4f46e5", text: "#ffffff", bg: "#0a0a14", font: "'DM Sans', sans-serif",                              fontLabel: "DM Sans",         mode: "dark" },
  { name: "Crimson Gi",     style: "Dark · Bold",      primary: "#be123c", secondary: "#9f1239", text: "#ffffff", bg: "#120508", font: "'Rajdhani', sans-serif",                              fontLabel: "Rajdhani",        mode: "dark" },
  // ── Light themes ──────────────────────────────────────────────────────────
  { name: "Clean White",    style: "Light · Modern",   primary: "#1d4ed8", secondary: "#3b82f6", text: "#1e293b", bg: "#f8fafc", font: "'Poppins', sans-serif",                              fontLabel: "Poppins",         mode: "light" },
  { name: "Fresh Green",    style: "Light · Wellness", primary: "#16a34a", secondary: "#22c55e", text: "#14532d", bg: "#f0fdf4", font: "'Outfit', sans-serif",                               fontLabel: "Outfit",          mode: "light" },
  { name: "Warm Sand",      style: "Light · Premium",  primary: "#d97706", secondary: "#f59e0b", text: "#451a03", bg: "#fffbeb", font: "'Raleway', sans-serif",                              fontLabel: "Raleway",         mode: "light" },
  { name: "Ocean Breeze",   style: "Light · Clean",    primary: "#0ea5e9", secondary: "#0284c7", text: "#0c4a6e", bg: "#f0f9ff", font: "'Saira', sans-serif",                                fontLabel: "Saira",           mode: "light" },
];

const ROLE_META: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  owner:   { label: "Owner",   color: "#f59e0b", icon: Crown },
  manager: { label: "Manager", color: "#8b5cf6", icon: Shield },
  coach:   { label: "Coach",   color: "#3b82f6", icon: User  },
  admin:   { label: "Admin",   color: "#10b981", icon: Settings },
};

const TIER_LABELS: Record<string, string> = {
  starter: "Starter", pro: "Pro", elite: "Elite", enterprise: "Enterprise",
};

// LB-005 (audit M4): the previous DEMO_REVENUE constant has been replaced by
// /api/revenue/summary which returns the same shape derived from real Payment
// + Member rows. The default below is the empty-tenant state — the component
// fetches and overwrites on mount.
type RevenueSummary = {
  mrr: number;
  arr: number;
  activeMembers: number;
  avgPerMember: number;
  growth: number;
  history: { month: string; revenue: number }[];
  memberships: { name: string; price: number; count: number; color: string }[];
  recent: { name: string; action: string; tier: string; date: string }[];
};

const EMPTY_REVENUE: RevenueSummary = {
  mrr: 0, arr: 0, activeMembers: 0, avgPerMember: 0, growth: 0,
  history: [], memberships: [], recent: [],
};

const INITIAL_PRODUCTS: StoreProduct[] = [
  { id: "1", name: "Club T-Shirt",     price: 25,  category: "clothing",  inStock: true,  emoji: "👕" },
  { id: "2", name: "Rashguard",        price: 40,  category: "clothing",  inStock: true,  emoji: "🥋" },
  { id: "3", name: "Protein Shake",    price: 4,   category: "drink",     inStock: true,  emoji: "🥤" },
  { id: "4", name: "Energy Bar",       price: 2,   category: "food",      inStock: false, emoji: "🍫" },
  { id: "5", name: "Mouth Guard",      price: 12,  category: "equipment", inStock: true,  emoji: "🦷" },
];

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-full max-w-md z-50 flex flex-col" style={{ background: "var(--sf-0)", borderLeft: "1px solid rgba(0,0,0,0.08)" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/8">
          <h2 className="text-white font-semibold text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400" style={{ background: "rgba(0,0,0,0.08)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </>
  );
}

// ─── Phone preview ────────────────────────────────────────────────────────────

// Logo height (px) inside the phone preview header — scaled for the 200px-wide preview frame
const PREVIEW_LOGO_PX: Record<"sm" | "md" | "lg", number> = { sm: 16, md: 24, lg: 36 };

function PhonePreview({ gymName, primaryCol, logoPreview, logoBg, logoSize, bgCol, fontFamily }: { gymName: string; primaryCol: string; logoPreview: string | null; logoBg?: "none" | "black" | "white"; logoSize?: "sm" | "md" | "lg"; bgCol?: string; fontFamily?: string }) {
  const bg = bgCol ?? "#111111";
  const font = fontFamily ?? "Inter, sans-serif";
  const isLight = bg.startsWith("#f") || bg.startsWith("#e") || bg === "#ffffff";
  const textPrimary = isLight ? "#0f172a" : "#ffffff";
  const textMuted = isLight ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.4)";
  const borderCol = isLight ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.08)";
  const surfaceCol = isLight ? "rgba(0,0,0,0.04)" : "rgba(0,0,0,0.03)";
  const logoPx = PREVIEW_LOGO_PX[logoSize ?? "md"];
  return (
    <div
      className="relative w-full h-full overflow-hidden"
      style={{ background: bg, fontFamily: font }}
    >
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2.5"
          style={{ background: `${bg}ee`, borderBottom: `1px solid ${borderCol}` }}
        >
          <div style={{ width: 22 }} />
          <div className="flex-1 text-center">
            {logoPreview ? (
              <div
                className="inline-flex items-center justify-center rounded px-1"
                style={{ background: logoBg === "black" ? "#000" : logoBg === "white" ? "#fff" : "transparent" }}
              >
                <img src={logoPreview} alt="logo" className="object-contain" style={{ height: logoPx, maxWidth: 96 }} />
              </div>
            ) : (
              <span className="font-bold text-xs truncate" style={{ color: textPrimary }}>{gymName || "Your Gym"}</span>
            )}
          </div>
          <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: surfaceCol }}>
            <Bell className="w-2.5 h-2.5" style={{ color: textMuted }} />
          </div>
        </div>

        {/* Body */}
        <div className="px-3 py-3 space-y-3">
          <div>
            <p className="font-bold text-sm" style={{ color: textPrimary }}>Good morning,</p>
            <p className="font-bold text-sm" style={{ color: primaryCol }}>Alex</p>
            <p className="text-[9px] mt-0.5" style={{ color: textMuted }}>Thursday, 10 Apr 2026</p>
          </div>

          <button
            className="w-full py-2 rounded-xl font-bold text-[10px] flex items-center justify-center gap-1"
            style={{ background: primaryCol, color: "#fff" }}
          >
            Sign In to Class
          </button>

          <div>
            <p className="font-semibold text-[10px] mb-1.5" style={{ color: textPrimary }}>Today&apos;s Classes</p>
            {[
              { name: "Beginner BJJ", time: "10:00" },
              { name: "No-Gi",        time: "18:00" },
            ].map((c) => (
              <div key={c.name} className="flex items-center gap-2 py-1.5" style={{ borderBottom: `1px solid ${borderCol}` }}>
                <div className="w-1 h-1 rounded-full shrink-0" style={{ background: primaryCol }} />
                <p className="text-[9px] font-medium flex-1 truncate" style={{ color: textPrimary }}>{c.name}</p>
                <p className="text-[8px]" style={{ color: textMuted }}>{c.time}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom nav */}
        <div
          className="absolute bottom-0 left-0 right-0 flex items-center justify-around py-2"
          style={{ background: `${bg}f8`, borderTop: `1px solid ${borderCol}` }}
        >
          {[
            { icon: Home,       label: "Home",     active: true },
            { icon: Calendar,   label: "Schedule", active: false },
            { icon: TrendingUp, label: "Progress", active: false },
            { icon: User,       label: "Profile",  active: false },
          ].map(({ icon: Icon, label, active }) => (
            <div key={label} className="flex flex-col items-center gap-0.5">
              <Icon className="w-3 h-3" style={{ color: active ? primaryCol : textMuted }} />
              <span className="text-[7px] font-medium" style={{ color: active ? primaryCol : textMuted }}>{label}</span>
            </div>
          ))}
        </div>
    </div>
  );
}

// ─── Staff card ───────────────────────────────────────────────────────────────

function StaffCard({ member, canEdit, onEdit, onDelete, isSelf }: { member: StaffMember; canEdit: boolean; onEdit: (m: StaffMember) => void; onDelete: (id: string) => void; isSelf: boolean }) {
  const meta = ROLE_META[member.role] ?? ROLE_META.admin;
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-2xl border" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: hex(meta.color, 0.15) }}>
        {member.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-semibold truncate">{member.name}</p>
          {isSelf && <span className="text-xs text-gray-600">(you)</span>}
        </div>
        <p className="text-gray-500 text-xs truncate">{member.email}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: hex(meta.color, 0.12), color: meta.color }}>
          <Icon className="w-3 h-3" />{meta.label}
        </span>
        {canEdit && member.role !== "owner" && (
          <div className="flex gap-1">
            <button onClick={() => onEdit(member)} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-colors"><Edit2 className="w-3.5 h-3.5" /></button>
            <button onClick={() => onDelete(member.id)} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── BACS Direct Debit toggle ────────────────────────────────────────────────

function BacsToggle({ initialAccepts, primaryColor }: { initialAccepts: boolean; primaryColor: string }) {
  const [accepts, setAccepts] = useState(initialAccepts);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function toggle() {
    const next = !accepts;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acceptsBacs: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update");
        return;
      }
      setAccepts(next);
      toast(next ? "Direct Debit enabled" : "Direct Debit disabled", "success");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rounded-2xl border p-5"
      style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-semibold text-sm">Accept Direct Debit (BACS)</p>
          <p className="text-gray-500 text-xs mt-1">
            Charge UK members 1% (capped £2) instead of 1.5% + 20p on cards. New subscriptions get a payment method picker.
            Mandate verification takes 2 working days; first collection 4 working days after that.
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={saving}
          className="shrink-0 inline-flex items-center justify-center w-12 h-7 rounded-full transition-colors disabled:opacity-60"
          style={{
            background: accepts ? primaryColor : "rgba(255,255,255,0.08)",
            border: `1px solid ${accepts ? primaryColor : "rgba(255,255,255,0.12)"}`,
          }}
          aria-label={accepts ? "Disable BACS" : "Enable BACS"}
          aria-pressed={accepts}
        >
          <span
            className="w-5 h-5 rounded-full bg-white transition-transform"
            style={{ transform: accepts ? "translateX(10px)" : "translateX(-10px)" }}
          />
        </button>
      </div>
      {error && <p className="text-xs mt-2 text-red-400">{error}</p>}
    </div>
  );
}

// ─── Member Self-Billing section ─────────────────────────────────────────────

function MemberSelfBillingSection({
  initialEnabled,
  initialEmail,
  initialUrl,
  primaryColor,
}: {
  initialEnabled: boolean;
  initialEmail: string | null;
  initialUrl: string | null;
  primaryColor: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save(patch: { memberSelfBilling?: boolean; billingContactEmail?: string | null; billingContactUrl?: string | null }) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update");
        return false;
      }
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    const next = !enabled;
    const ok = await save({ memberSelfBilling: next });
    if (ok) {
      setEnabled(next);
      toast(next ? "Self-service billing enabled" : "Self-service billing disabled", "success");
    }
  }

  async function saveContact() {
    const ok = await save({
      billingContactEmail: email.trim() || null,
      billingContactUrl: url.trim() || null,
    });
    if (ok) toast("Billing contact saved", "success");
  }

  return (
    <div
      className="rounded-2xl border p-5 space-y-4"
      style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
    >
      {/* Toggle row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-semibold text-sm">Allow members to manage their own billing</p>
          <p className="text-gray-500 text-xs mt-1">
            {enabled
              ? "Members can manage their own subscription via Stripe."
              : "Members will see your contact details instead of self-service billing."}
          </p>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={saving}
          className="shrink-0 inline-flex items-center justify-center w-12 h-7 rounded-full transition-colors disabled:opacity-60"
          style={{
            background: enabled ? primaryColor : "rgba(255,255,255,0.08)",
            border: `1px solid ${enabled ? primaryColor : "rgba(255,255,255,0.12)"}`,
          }}
          aria-label={enabled ? "Disable member self-billing" : "Enable member self-billing"}
          aria-pressed={enabled}
        >
          <span
            className="w-5 h-5 rounded-full bg-white transition-transform"
            style={{ transform: enabled ? "translateX(10px)" : "translateX(-10px)" }}
          />
        </button>
      </div>

      {/* Contact fields (always visible so owner can pre-fill before toggling off) */}
      <div className="space-y-3 pt-1 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Billing contact (shown when self-service is off)</p>
        <div className="space-y-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="billing@yourgym.com"
            className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none focus:border-white/20"
            style={{ borderColor: "rgba(255,255,255,0.1)" }}
          />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://yourgym.com/billing"
            className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none focus:border-white/20"
            style={{ borderColor: "rgba(255,255,255,0.1)" }}
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          onClick={saveContact}
          disabled={saving}
          className="px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
          style={{ background: primaryColor }}
        >
          {saving ? "Saving…" : "Save contact details"}
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPage({ settings, staff: initialStaff, statusCounts, primaryColor, role, currentUserId, totpEnabled: initTotpEnabled = false, stripeConnected: initStripeConnected = false, stripeAccountId: initStripeAccountId = null }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTabState] = useState<Tab>(() => {
    const requested = searchParams.get("tab");
    return isTab(requested) ? requested : "overview";
  });

  // Wrapper that updates both the local tab state and the URL search-param,
  // so deep-linking and browser back/forward navigation behave correctly.
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    const usp = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === "overview") usp.delete("tab");
    else usp.set("tab", next);
    const qs = usp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);
  const [staff, setStaff] = useState<StaffMember[]>(initialStaff);

  // Branding state
  const [gymName, setGymName]           = useState(settings?.name ?? "");
  const [primaryCol, setPrimaryCol]     = useState(settings?.primaryColor   ?? primaryColor);
  const [secondaryCol, setSecondaryCol] = useState(settings?.secondaryColor ?? "#2563eb");
  const [textCol, setTextCol]           = useState(settings?.textColor      ?? "#ffffff");
  const [bgCol, setBgCol]               = useState("#111111");
  const [fontFamily, setFontFamily]     = useState("Inter, sans-serif");
  const [logoPreview, setLogoPreview]   = useState<string | null>(settings?.logoUrl ?? null);
  const [logoFile, setLogoFile]         = useState<File | null>(null);
  const [logoBg, setLogoBg]             = useState<"none" | "black" | "white">("none");
  const [logoSize, setLogoSize]         = useState<"sm" | "md" | "lg">((settings?.logoSize as "sm" | "md" | "lg") ?? "md");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [saving, setSaving]             = useState(false);
  const [copied, setCopied]             = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Staff drawer
  const [staffDrawer, setStaffDrawer] = useState(false);
  const [editStaff, setEditStaff]     = useState<StaffMember | null>(null);
  const [sfName, setSfName]           = useState("");
  const [sfEmail, setSfEmail]         = useState("");
  const [sfRole, setSfRole]           = useState<"manager" | "coach" | "admin">("coach");
  const [sfPassword, setSfPassword]   = useState("");
  const [sfSaving, setSfSaving]       = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  // Store state — backed by /api/products. INITIAL_PRODUCTS is only the
  // fallback shown while the first fetch is in flight (so the tab doesn't
  // flash empty). Real data overwrites it after mount.
  const [products, setProducts]         = useState<StoreProduct[]>(INITIAL_PRODUCTS);
  const [productSaving, setProductSaving]   = useState(false);
  const [productDrawer, setProductDrawer] = useState(false);

  // LB-005: real revenue data fetched on mount when Revenue tab is opened.
  const [revenue, setRevenue] = useState<RevenueSummary>(EMPTY_REVENUE);
  const [revenueLoaded, setRevenueLoaded] = useState(false);
  const [editProduct, setEditProduct]     = useState<StoreProduct | null>(null);
  const [pName, setPName]   = useState("");
  const [pPrice, setPPrice] = useState("");
  const [pCat, setPCat]     = useState<StoreProduct["category"]>("clothing");
  const [pEmoji, setPEmoji] = useState("👕");
  const [pStock, setPStock] = useState(true);

  // TOTP state
  const [mfaEnabled, setMfaEnabled]     = useState(initTotpEnabled);
  const [totpSetupDrawer, setTotpSetupDrawer] = useState(false);
  const [totpDisableDrawer, setTotpDisableDrawer] = useState(false);
  const [totpStep, setTotpStep]         = useState<1 | 2>(1);
  const [totpQrUrl, setTotpQrUrl]       = useState("");
  const [totpSecret, setTotpSecret]     = useState("");
  const [totpCode, setTotpCode]         = useState("");
  const [totpSaving, setTotpSaving]     = useState(false);
  const [totpError, setTotpError]       = useState("");
  const [disableCode, setDisableCode]   = useState("");
  const [disableSaving, setDisableSaving] = useState(false);
  const [disableError, setDisableError] = useState("");

  // Waiver state
  const [waiverTitle, setWaiverTitle]     = useState(settings?.waiverTitle ?? "");
  const [waiverContent, setWaiverContent] = useState(settings?.waiverContent ?? "");
  const [waiverEditing, setWaiverEditing] = useState(false);
  const [waiverSaving, setWaiverSaving]   = useState(false);

  // Stripe Connect state
  const [stripeIsConnected, setStripeIsConnected] = useState(initStripeConnected);
  const [stripeAccount, setStripeAccount]         = useState<string | null>(initStripeAccountId);
  const [plans, setPlans]                         = useState<{ id: string; name: string; amount: number; currency: string; interval: string }[]>([]);
  const [plansLoaded, setPlansLoaded]             = useState(false);
  const [planDrawer, setPlanDrawer]               = useState(false);
  const [planName, setPlanName]                   = useState("");
  const [planPrice, setPlanPrice]                 = useState("");
  const [planInterval, setPlanInterval]           = useState<"month" | "year">("month");
  const [planSaving, setPlanSaving]               = useState(false);
  const [stripeDisconnecting, setStripeDisconnecting] = useState(false);

  const { toast } = useToast();
  const isOwner = role === "owner";

  // Sync tab state when the URL changes externally (back/forward, deep link).
  // Use setTabState directly — going through setTab would push a redundant
  // router.replace and re-trigger this effect.
  useEffect(() => {
    const requested = searchParams.get("tab");
    setTabState(isTab(requested) ? requested : "overview");
  }, [searchParams]);

  useEffect(() => {
    try {
      const localSettings = JSON.parse(localStorage.getItem("gym-settings") ?? "{}") as Record<string, unknown>;
      if (typeof localSettings.primaryColor === "string") setPrimaryCol(localSettings.primaryColor);
      if (typeof localSettings.secondaryColor === "string") setSecondaryCol(localSettings.secondaryColor);
      if (typeof localSettings.textColor === "string") setTextCol(localSettings.textColor);
      if (typeof localSettings.bgColor === "string") setBgCol(localSettings.bgColor);
      if (typeof localSettings.fontFamily === "string") setFontFamily(localSettings.fontFamily);
      if (typeof localSettings.logoUrl === "string") setLogoPreview(localSettings.logoUrl);
      if (localSettings.logoBg === "none" || localSettings.logoBg === "black" || localSettings.logoBg === "white") setLogoBg(localSettings.logoBg);
      if (localSettings.logoSize === "sm" || localSettings.logoSize === "md" || localSettings.logoSize === "lg") setLogoSize(localSettings.logoSize);
      if (typeof localSettings.presetName === "string") setActivePreset(localSettings.presetName);
    } catch { /* ignore local preview state */ }
  }, []);

  // Load Google Fonts when branding tab is open or font changes
  const FONT_IMPORTS_MAP: Record<string, string> = {
    "Inter":            "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    "Oswald":           "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap",
    "Montserrat":       "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap",
    "Space Grotesk":    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
    "Rajdhani":         "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap",
    "Playfair Display": "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700;800&display=swap",
    // Legacy — kept for presets that referenced these
    "Plus Jakarta Sans": "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
    "Barlow":            "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap",
    "DM Sans":           "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap",
    "Poppins":           "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap",
    "Outfit":            "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap",
    "Raleway":           "https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700;800&display=swap",
    "Saira":             "https://fonts.googleapis.com/css2?family=Saira:wght@400;500;600;700&display=swap",
  };

  useEffect(() => {
    if (tab !== "branding") return;
    // Preload all fonts so the picker previews work
    Object.entries(FONT_IMPORTS_MAP).forEach(([name, url]) => {
      const id = `gfont-${name.replace(/\s/g, "-").toLowerCase()}`;
      if (!document.getElementById(id)) {
        const link = document.createElement("link");
        link.id = id; link.rel = "stylesheet"; link.href = url;
        document.head.appendChild(link);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab === "revenue" && stripeIsConnected) loadPlans();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, stripeIsConnected]);

  const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "overview",  label: "Overview",  icon: LayoutDashboard },
    { id: "branding",  label: "Branding",  icon: Palette },
    { id: "revenue",   label: "Revenue",   icon: DollarSign },
    { id: "store",     label: "Store",     icon: ShoppingBag },
    { id: "staff",     label: "Staff",     icon: Users },
    { id: "account",   label: "Account",   icon: Shield },
    { id: "waiver",    label: "Waiver",    icon: FileText },
    { id: "integrations", label: "Integrations", icon: Cable },
  ];

  const inputCls = "w-full bg-transparent border border-black/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-white/30 transition-colors";
  const totalMembers = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  async function openTotpSetup() {
    setTotpCode(""); setTotpError(""); setTotpStep(1);
    setTotpSetupDrawer(true);
    setTotpSaving(true);
    try {
      const res = await fetch("/api/auth/totp/setup");
      const data = await res.json() as { secret?: string; qrDataUrl?: string };
      setTotpQrUrl(data.qrDataUrl ?? "");
      setTotpSecret(data.secret ?? "");
    } catch { setTotpError("Failed to load QR code."); }
    setTotpSaving(false);
  }

  async function confirmTotpSetup() {
    setTotpSaving(true); setTotpError("");
    const res = await fetch("/api/auth/totp/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: totpCode }),
    });
    if (res.ok) {
      setMfaEnabled(true);
      setTotpSetupDrawer(false);
      toast("Two-factor authentication enabled", "success");
    } else {
      const d = await res.json() as { error?: string };
      setTotpError(d.error ?? "Invalid code.");
    }
    setTotpSaving(false);
  }

  async function confirmTotpDisable() {
    setDisableSaving(true); setDisableError("");
    const res = await fetch("/api/auth/totp/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: disableCode }),
    });
    if (res.ok) {
      setMfaEnabled(false);
      setTotpDisableDrawer(false);
      toast("Two-factor authentication disabled", "success");
    } else {
      const d = await res.json() as { error?: string };
      setDisableError(d.error ?? "Invalid code.");
    }
    setDisableSaving(false);
  }

  // ── Stripe Connect handlers ───────────────────────────────────────────────
  async function connectStripe() {
    const ackd = window.confirm(
      "Before connecting Stripe:\n\n" +
      "By continuing you agree to MatFlow's Platform Terms of Service, Acceptable Use Policy, and Privacy Policy " +
      "(matflow.io/legal). You confirm that you (the gym) are the merchant of record for all payments " +
      "collected via this account, and that MatFlow is a software platform — not a payment processor or " +
      "party to your customer contracts.\n\n" +
      "Click OK to continue to Stripe."
    );
    if (!ackd) return;
    const res = await fetch("/api/stripe/connect");
    if (res.ok) {
      const { url } = await res.json() as { url: string };
      window.location.href = url;
    } else {
      toast("Failed to start Stripe connection", "error");
    }
  }

  async function disconnectStripe() {
    setStripeDisconnecting(true);
    const res = await fetch("/api/stripe/disconnect", { method: "POST" });
    if (res.ok) {
      setStripeIsConnected(false);
      setStripeAccount(null);
      setPlans([]);
      setPlansLoaded(false);
      toast("Stripe account disconnected", "success");
    } else {
      toast("Failed to disconnect Stripe", "error");
    }
    setStripeDisconnecting(false);
  }

  async function loadPlans() {
    if (plansLoaded) return;
    const res = await fetch("/api/stripe/subscription-plans");
    if (res.ok) {
      const { plans: data } = await res.json() as { plans: typeof plans };
      setPlans(data);
    }
    setPlansLoaded(true);
  }

  async function createPlan() {
    if (!planName.trim() || !planPrice || Number(planPrice) <= 0) return;
    setPlanSaving(true);
    const res = await fetch("/api/stripe/subscription-plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: planName.trim(), amount: Number(planPrice), interval: planInterval }),
    });
    if (res.ok) {
      const plan = await res.json() as { id: string; name: string; amount: number; currency: string; interval: string };
      setPlans((p) => [...p, plan]);
      setPlanDrawer(false);
      setPlanName(""); setPlanPrice(""); setPlanInterval("month");
      toast("Plan created", "success");
    } else {
      const d = await res.json() as { error?: string };
      toast(d.error ?? "Failed to create plan", "error");
    }
    setPlanSaving(false);
  }

  // ── Branding save ─────────────────────────────────────────────────────────
  async function saveBranding() {
    setSaving(true);
    let uploadError: string | null = null;
    try {
      // 1. Upload logo file if one was selected
      let finalLogoUrl = logoPreview;
      if (logoFile) {
        const fd = new FormData();
        fd.append("file", logoFile);
        const upRes = await fetch("/api/upload", { method: "POST", body: fd });
        if (upRes.ok) {
          const { url } = await upRes.json();
          finalLogoUrl = url;
        } else {
          // Surface the failure instead of silently writing logoUrl=null to the DB.
          // Common cause: BLOB_READ_WRITE_TOKEN missing in Vercel env (returns 503).
          const errBody = await upRes.json().catch(() => ({} as { error?: string }));
          uploadError = errBody.error ?? `Logo upload failed (HTTP ${upRes.status})`;
          finalLogoUrl = logoPreview;
        }
      }

      // 2. Persist to localStorage for demo mode (always works)
      const localData = { slug: settings?.slug, primaryColor: primaryCol, secondaryColor: secondaryCol, textColor: textCol, bgColor: bgCol, fontFamily, logoUrl: finalLogoUrl, logoBg, logoSize, presetName: activePreset };
      localStorage.setItem("gym-settings", JSON.stringify(localData));

      // Apply CSS vars immediately (admin dashboard colours only — bgColor stays in member app)
      const root = document.documentElement;
      root.style.setProperty("--color-primary",          primaryCol);
      root.style.setProperty("--color-secondary",        secondaryCol);
      root.style.setProperty("--color-text",             textCol);
      root.style.setProperty("--color-primary-dim",      hex(primaryCol, 0.1));
      root.style.setProperty("--color-primary-border",   hex(primaryCol, 0.25));
      root.style.setProperty("--color-secondary-dim",    hex(secondaryCol, 0.12));
      root.style.setProperty("--color-secondary-border", hex(secondaryCol, 0.3));
      root.style.setProperty("--color-text-muted",       hex(textCol, 0.4));
      root.style.setProperty("--color-text-subtle",      hex(textCol, 0.2));

      // 3. Save to DB
      try {
        const persistedLogoUrl =
          typeof finalLogoUrl === "string" && finalLogoUrl.length > 0 && !finalLogoUrl.startsWith("data:")
            ? finalLogoUrl
            : null;
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: gymName,
            primaryColor: primaryCol,
            secondaryColor: secondaryCol,
            textColor: textCol,
            bgColor: bgCol,
            fontFamily,
            logoUrl: persistedLogoUrl,
            logoSize,
          }),
        });
      } catch { /* DB not available in demo mode */ }

      setLogoFile(null);
      if (uploadError) {
        toast(`Branding saved, but ${uploadError}`, "error");
      } else {
        toast("Branding saved — member app updated", "success");
      }
    } catch {
      toast("Failed to save branding", "error");
    } finally {
      setSaving(false);
    }
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setLogoPreview(dataUrl);
      // Save preview immediately to localStorage so member app updates
      try {
        const existing = JSON.parse(localStorage.getItem("gym-settings") ?? "{}");
        localStorage.setItem("gym-settings", JSON.stringify({ ...existing, slug: settings?.slug, logoUrl: dataUrl, logoBg }));
      } catch { /* ignore */ }
    };
    reader.readAsDataURL(file);
  }

  // ── Staff actions ─────────────────────────────────────────────────────────
  function openAddStaff() {
    setEditStaff(null);
    setSfName(""); setSfEmail(""); setSfRole("coach"); setSfPassword(""); setTempPassword(null);
    setStaffDrawer(true);
  }

  function openEditStaff(m: StaffMember) {
    setEditStaff(m);
    setSfName(m.name); setSfEmail(m.email); setSfRole(m.role as "manager" | "coach" | "admin"); setSfPassword(""); setTempPassword(null);
    setStaffDrawer(true);
  }

  async function handleStaffSave() {
    setSfSaving(true);
    try {
      if (editStaff) {
        const body: Record<string, unknown> = { name: sfName, role: sfRole };
        if (sfPassword) body.newPassword = sfPassword;
        const res = await fetch(`/api/staff/${editStaff.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error((await res.json()).error);
        const updated = await res.json();
        setStaff((prev) => prev.map((s) => s.id === editStaff.id ? { ...s, ...updated } : s));
        toast("Staff member updated", "success");
        setStaffDrawer(false);
      } else {
        const body: Record<string, unknown> = { name: sfName, email: sfEmail, role: sfRole };
        if (sfPassword) body.password = sfPassword;
        const res = await fetch("/api/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error((await res.json()).error);
        const created = await res.json();
        setStaff((prev) => [...prev, { id: created.id, name: created.name, email: created.email, role: created.role, createdAt: created.createdAt ?? new Date().toISOString() }]);
        if (created.temporaryPassword) setTempPassword(created.temporaryPassword);
        else { setStaffDrawer(false); toast("Staff member added", "success"); }
      }
    } catch (e: unknown) {
      toast((e as Error).message || "Something went wrong", "error");
    } finally {
      setSfSaving(false);
    }
  }

  async function handleStaffDelete(id: string) {
    if (!confirm("Remove this staff member?")) return;
    try {
      const res = await fetch(`/api/staff/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      setStaff((prev) => prev.filter((s) => s.id !== id));
      toast("Staff member removed", "success");
    } catch (e: unknown) {
      toast((e as Error).message || "Could not remove staff", "error");
    }
  }

  // ── Store actions ─────────────────────────────────────────────────────────

  // LB-005: lazy-fetch revenue summary the first time the Revenue tab opens.
  // Avoids a wasted query on every Settings page load — most owners only
  // visit Revenue occasionally.
  useEffect(() => {
    if (tab !== "revenue" || revenueLoaded) return;
    let cancelled = false;
    fetch("/api/revenue/summary")
      .then((r) => (r.ok ? r.json() : EMPTY_REVENUE))
      .then((d: RevenueSummary) => { if (!cancelled) setRevenue(d); })
      .catch(() => { if (!cancelled) setRevenue(EMPTY_REVENUE); })
      .finally(() => { if (!cancelled) setRevenueLoaded(true); });
    return () => { cancelled = true; };
  }, [tab, revenueLoaded]);

  // Pull live products from the API once on mount. Server returns rows with
  // pricePence + symbol; map to the UI shape (price in major units + emoji).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/products")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; name: string; pricePence: number; category: StoreProduct["category"]; symbol: string | null; inStock: boolean }>) => {
        if (cancelled) return;
        if (Array.isArray(rows) && rows.length > 0) {
          setProducts(rows.map((r) => ({
            id: r.id,
            name: r.name,
            price: r.pricePence / 100,
            category: r.category,
            emoji: r.symbol ?? "🛍️",
            inStock: r.inStock,
          })));
        }
      })
      .catch(() => { /* keep INITIAL_PRODUCTS fallback in place */ });
    return () => { cancelled = true; };
  }, []);

  function openAddProduct() {
    setEditProduct(null);
    setPName(""); setPPrice(""); setPCat("clothing"); setPEmoji("👕"); setPStock(true);
    setProductDrawer(true);
  }

  function openEditProduct(p: StoreProduct) {
    setEditProduct(p);
    setPName(p.name); setPPrice(String(p.price)); setPCat(p.category); setPEmoji(p.emoji); setPStock(p.inStock);
    setProductDrawer(true);
  }

  async function saveProduct() {
    if (!pName.trim() || !pPrice) return;
    const priceNum = parseFloat(pPrice);
    if (Number.isNaN(priceNum) || priceNum < 0) { toast("Enter a valid price", "error"); return; }
    const payload = {
      name: pName.trim(),
      pricePence: Math.round(priceNum * 100),
      category: pCat,
      symbol: pEmoji || null,
      inStock: pStock,
    };
    setProductSaving(true);
    try {
      if (editProduct) {
        const res = await fetch(`/api/products/${editProduct.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
        setProducts((prev) => prev.map((p) => p.id === editProduct.id ? { ...p, name: payload.name, price: priceNum, category: pCat, emoji: pEmoji, inStock: pStock } : p));
        toast("Product updated", "success");
      } else {
        const res = await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
        const created = await res.json() as { id: string };
        setProducts((prev) => [...prev, { id: created.id, name: payload.name, price: priceNum, category: pCat, emoji: pEmoji, inStock: pStock }]);
        toast("Product added", "success");
      }
      setProductDrawer(false);
    } catch (e: unknown) {
      toast((e as Error).message || "Could not save product", "error");
    } finally {
      setProductSaving(false);
    }
  }

  async function deleteProduct(id: string) {
    if (!confirm("Remove this product?")) return;
    // Optimistic remove — restore on failure.
    const prev = products;
    setProducts((p) => p.filter((x) => x.id !== id));
    try {
      const res = await fetch(`/api/products/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not remove");
      toast("Product removed", "success");
    } catch (e: unknown) {
      setProducts(prev);
      toast((e as Error).message || "Could not remove product", "error");
    }
  }

  // Guard for empty tenants — Math.max() on an empty array returns -Infinity
  // which breaks the bar-height calc below. 1 is a safe denominator.
  const maxRevenue = revenue.history.length > 0
    ? Math.max(1, ...revenue.history.map((h) => h.revenue))
    : 1;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header — gradient eyebrow + tenant chip + account bar */}
      <div className="mb-5 relative flex items-start justify-between gap-4">
        {/* Left: title block */}
        <div className="relative min-w-0">
          <div
            className="absolute -top-2 -left-4 w-32 h-32 rounded-full blur-3xl opacity-30 pointer-events-none"
            style={{ background: `radial-gradient(circle, ${primaryCol} 0%, transparent 70%)` }}
          />
          <div className="relative flex items-center gap-3 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: hex(primaryCol, 0.8) }}>Workspace</span>
            <span className="h-px w-16" style={{ background: `linear-gradient(to right, ${hex(primaryCol, 0.4)}, transparent)` }} />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Settings</h1>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border" style={{ background: hex(primaryCol, 0.08), borderColor: hex(primaryCol, 0.25), color: primaryCol }}>
              <span className="w-1 h-1 rounded-full" style={{ background: primaryCol }} />
              {settings?.name ?? "Your gym"}
            </span>
            <span className="text-gray-600 text-xs">·</span>
            <span className="text-gray-500 text-xs">{settings ? TIER_LABELS[settings.subscriptionTier] ?? settings.subscriptionTier : ""} plan</span>
          </div>
        </div>

        {/* Right: account bar */}
        {(() => {
          const me = staff.find((s) => s.id === currentUserId);
          if (!me) return null;
          const initials = me.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
          const roleLabel = ROLE_META[me.role as keyof typeof ROLE_META]?.label ?? me.role;
          const roleColor = ROLE_META[me.role as keyof typeof ROLE_META]?.color ?? primaryCol;
          return (
            <div
              className="shrink-0 flex items-center gap-3 px-3 py-2.5 rounded-2xl border"
              style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
            >
              {/* Avatar */}
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
                style={{ background: hex(primaryCol, 0.15), color: primaryCol }}
              >
                {initials}
              </div>
              {/* Info */}
              <div className="min-w-0">
                <p className="text-white text-xs font-semibold leading-tight truncate max-w-[120px]">{me.name}</p>
                <p className="text-gray-500 text-[10px] truncate max-w-[120px]">{me.email}</p>
                <span
                  className="inline-block mt-0.5 px-1.5 py-px rounded-full text-[9px] font-semibold"
                  style={{ background: hex(roleColor, 0.12), color: roleColor }}
                >
                  {roleLabel}
                </span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Sticky tab bar with backdrop blur */}
      <div
        className="sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 pt-2 pb-3 mb-6 overflow-x-auto scrollbar-hide"
        style={{
          background: "linear-gradient(to bottom, var(--sf-0, rgba(10,10,10,0.98)) 0%, var(--sf-0, rgba(10,10,10,0.85)) 70%, transparent 100%)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div className="flex gap-1 p-1 rounded-xl min-w-max" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)}
                className="relative flex items-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
                style={{
                  background: active ? hex(primaryCol, 0.15) : "transparent",
                  color: active ? "#fff" : "rgba(255,255,255,0.45)",
                  boxShadow: active ? `inset 0 0 0 1px ${hex(primaryCol, 0.3)}` : "none",
                }}
              >
                <Icon className="w-3.5 h-3.5" style={{ color: active ? primaryCol : undefined }} />{label}
                {active && <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full" style={{ background: primaryCol }} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Overview ── */}
      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Members", value: totalMembers || settings?.memberCount || 0 },
              { label: "Staff",   value: settings?.staffCount ?? staff.length },
              { label: "Classes", value: settings?.classCount ?? 0 },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-2xl border p-4 text-center" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
                <p className="text-white text-2xl font-bold">{value}</p>
                <p className="text-gray-500 text-xs mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Member Status</h2>
            {[
              { key: "active",    label: "Active",    color: "#10b981" },
              { key: "taster",    label: "Tasters",   color: "#3b82f6" },
              { key: "paused",    label: "Paused",    color: "#f59e0b" },
              { key: "inactive",  label: "Inactive",  color: "#6b7280" },
              { key: "cancelled", label: "Cancelled", color: "#ef4444" },
            ].map(({ key, label, color }) => {
              const count = statusCounts[key] ?? 0;
              if (count === 0) return null;
              return (
                <div key={key} className="flex items-center justify-between py-2 border-b border-black/8 last:border-0">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                    <span className="text-gray-400 text-sm">{label}</span>
                  </div>
                  <span className="text-white text-sm font-semibold">{count}</span>
                </div>
              );
            })}
            {totalMembers === 0 && <p className="text-gray-600 text-sm text-center py-4">No members yet</p>}
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Gym Info</h2>
            {[
              { label: "Gym name",     value: settings?.name },
              { label: "Club code",    value: settings?.slug },
              { label: "Plan",         value: settings ? TIER_LABELS[settings.subscriptionTier] : null },
              { label: "Member since", value: settings ? new Date(settings.createdAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : null },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between py-2 border-b border-black/8 last:border-0">
                <span className="text-gray-400 text-sm">{label}</span>
                <span className="text-white text-sm font-medium">{value ?? "—"}</span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Branding",      icon: Palette,      action: () => setTab("branding") },
              { label: "Revenue",       icon: DollarSign,   action: () => setTab("revenue") },
              { label: "Club Store",    icon: ShoppingBag,  action: () => setTab("store") },
              { label: "Manage Staff",  icon: Users,        action: () => setTab("staff") },
            ].map(({ label, icon: Icon, action }) => (
              <button key={label} onClick={action}
                className="flex items-center justify-between p-4 rounded-2xl border hover:bg-black/4 transition-all"
                style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
              >
                <div className="flex items-center gap-3">
                  <Icon className="w-4 h-4" style={{ color: primaryColor }} />
                  <span className="text-white text-sm font-medium">{label}</span>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-600" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Branding ── */}
      {tab === "branding" && (
        <div className="flex gap-8" style={{ alignItems: "flex-start" }}>
          {/* ── Left: settings column (scrolls independently) ── */}
          <div className="flex-1 min-w-0 space-y-6">
          {!isOwner && (
            <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-yellow-400 text-sm">
              Only the gym owner can change branding settings.
            </div>
          )}

          {/* Gym name */}
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Gym Name</label>
            <input className={inputCls} value={gymName} onChange={(e) => setGymName(e.target.value)} disabled={!isOwner} placeholder="Total BJJ" />
            <p className="text-gray-600 text-xs mt-1">Shown in the member app header if no logo is uploaded.</p>
          </div>

          {/* Logo upload */}
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Club Logo</label>
            <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
            <div
              onClick={() => isOwner && logoInputRef.current?.click()}
              className="border-2 border-dashed rounded-2xl p-6 flex flex-col items-center gap-3 transition-all"
              style={{
                borderColor: logoPreview ? hex(primaryCol, 0.4) : "rgba(255,255,255,0.1)",
                background: logoPreview ? hex(primaryCol, 0.04) : "rgba(0,0,0,0.02)",
                cursor: isOwner ? "pointer" : "default",
              }}
            >
              {logoPreview ? (
                <div className="flex flex-col items-center gap-2">
                  <img src={logoPreview} alt="logo" className="h-12 object-contain" />
                  {isOwner && (
                    <div className="flex gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); logoInputRef.current?.click(); }}
                        className="text-xs px-3 py-1.5 rounded-lg border border-black/10 text-gray-400 hover:text-white transition-colors"
                      >
                        Replace
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setLogoPreview(null); }}
                        className="text-xs px-3 py-1.5 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-gray-600" />
                  <div className="text-center">
                    <p className="text-white text-sm font-medium">Click to upload logo</p>
                    <p className="text-gray-500 text-xs mt-1">PNG with transparent background recommended · Max 2MB</p>
                  </div>
                </>
              )}
            </div>
            <p className="text-gray-600 text-xs mt-1.5">Replaces the gym name text in the member app header when set.</p>
          </div>

          {/* Logo size — visual previews at actual scale */}
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Logo Size</label>
            <p className="text-gray-600 text-[10px] mb-2">Sized as it appears in the member-app header</p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: "sm", desc: "Small",  px: 14 },
                { value: "md", desc: "Normal", px: 22 },
                { value: "lg", desc: "Large",  px: 32 },
              ] as const).map(({ value, desc, px }) => {
                const active = logoSize === value;
                return (
                  <button
                    key={value}
                    onClick={() => { if (isOwner) setLogoSize(value); }}
                    disabled={!isOwner}
                    className="relative flex flex-col items-center justify-end gap-2 px-3 py-3 rounded-2xl border transition-all disabled:opacity-40 overflow-hidden"
                    style={{
                      borderColor: active ? hex(primaryCol, 0.6) : "rgba(0,0,0,0.10)",
                      background: active ? hex(primaryCol, 0.08) : "rgba(0,0,0,0.02)",
                      minHeight: 90,
                    }}
                  >
                    {/* Mini app-header mock with the actual logo at scale */}
                    <div className="flex-1 w-full flex items-center justify-center px-2 pt-1">
                      <div className="w-full rounded-md flex items-center justify-center" style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)", height: 44 }}>
                        {logoPreview ? (
                          <img src={logoPreview} alt="" className="object-contain" style={{ height: px, maxWidth: "80%", filter: active ? "none" : "grayscale(0.4) opacity(0.7)" }} />
                        ) : (
                          <span className="font-bold text-white tracking-tight" style={{ fontSize: px * 0.55 }}>
                            {(gymName || "G").charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] font-semibold tracking-wide" style={{ color: active ? primaryCol : "rgba(0,0,0,0.60)" }}>
                      {desc}
                    </span>
                    {active && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full" style={{ background: primaryCol, boxShadow: `0 0 8px ${primaryCol}` }} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Theme presets */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-gray-400 text-xs font-medium">Theme Presets</label>
              <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: "rgba(0,0,0,0.08)" }}>
                {(["dark", "light"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      const first = THEME_PRESETS.find((p) => p.mode === m);
                      if (first) { setPrimaryCol(first.primary); setSecondaryCol(first.secondary); setTextCol(first.text); setBgCol(first.bg); setFontFamily(first.font); setActivePreset(first.name); }
                    }}
                    className="px-3 py-1 rounded-md text-[10px] font-semibold capitalize transition-all"
                    style={{
                      background: THEME_PRESETS.find((p) => p.mode === m && p.name === activePreset) ? "rgba(0,0,0,0.10)" : "transparent",
                      color: THEME_PRESETS.find((p) => p.mode === m && p.name === activePreset) ? "#fff" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {m === "dark" ? "Dark" : "Light"}
                  </button>
                ))}
              </div>
            </div>

            {/* Dark presets */}
            <div className="mb-2">
              <p className="text-gray-600 text-[10px] mb-2 uppercase tracking-wider font-medium">Dark Mode</p>
              <div className="grid grid-cols-2 gap-2">
                {THEME_PRESETS.filter((p) => p.mode === "dark").map((preset) => {
                  const isActive = activePreset === preset.name;
                  return (
                    <button
                      key={preset.name}
                      onClick={() => { if (!isOwner) return; setPrimaryCol(preset.primary); setSecondaryCol(preset.secondary); setTextCol(preset.text); setBgCol(preset.bg); setFontFamily(preset.font); setActivePreset(preset.name); }}
                      disabled={!isOwner}
                      className="flex items-center gap-3 p-3 rounded-2xl border text-left transition-all disabled:opacity-40"
                      style={{
                        borderColor: isActive ? hex(preset.primary, 0.6) : "rgba(0,0,0,0.08)",
                        background: isActive ? hex(preset.primary, 0.08) : "rgba(0,0,0,0.02)",
                      }}
                    >
                      {/* Mini phone thumbnail */}
                      <div
                        className="relative shrink-0 rounded-lg overflow-hidden"
                        style={{
                          width: 38,
                          height: 56,
                          background: preset.bg,
                          border: `1px solid ${preset.mode === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`,
                          fontFamily: preset.font,
                        }}
                      >
                        <div className="absolute top-1 left-1 right-1 h-1 rounded-full" style={{ background: preset.mode === "dark" ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.06)" }} />
                        <div className="absolute top-3 left-1.5 right-1.5">
                          <div className="h-1 rounded-sm mb-0.5" style={{ background: preset.text, opacity: 0.55, width: "60%" }} />
                          <div className="h-0.5 rounded-sm" style={{ background: preset.primary, width: "35%" }} />
                        </div>
                        <div className="absolute left-1.5 right-1.5 rounded-sm" style={{ top: 14, height: 5, background: preset.primary }} />
                        <div className="absolute left-1.5 right-1.5" style={{ top: 22 }}>
                          <div className="h-0.5 rounded-sm mb-0.5" style={{ background: preset.text, opacity: 0.4, width: "80%" }} />
                          <div className="h-0.5 rounded-sm mb-0.5" style={{ background: preset.text, opacity: 0.4, width: "55%" }} />
                          <div className="h-0.5 rounded-sm" style={{ background: preset.secondary, opacity: 0.7, width: "70%" }} />
                        </div>
                        {/* nav bar */}
                        <div className="absolute bottom-0 left-0 right-0 h-2 flex items-center justify-around" style={{ background: preset.mode === "dark" ? "rgba(0,0,0,0.03)" : "rgba(0,0,0,0.04)", borderTop: `1px solid ${preset.mode === "dark" ? "rgba(0,0,0,0.10)" : "rgba(0,0,0,0.08)"}` }}>
                          <span className="w-0.5 h-0.5 rounded-full" style={{ background: preset.primary }} />
                          <span className="w-0.5 h-0.5 rounded-full" style={{ background: preset.text, opacity: 0.3 }} />
                          <span className="w-0.5 h-0.5 rounded-full" style={{ background: preset.text, opacity: 0.3 }} />
                          <span className="w-0.5 h-0.5 rounded-full" style={{ background: preset.text, opacity: 0.3 }} />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-semibold truncate">{preset.name}</p>
                        <p className="text-gray-600 text-[9px] truncate">{preset.style} · {preset.fontLabel}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Light presets */}
            <div>
              <p className="text-gray-600 text-[10px] mb-2 uppercase tracking-wider font-medium">Light Mode</p>
              <div className="grid grid-cols-2 gap-2">
                {THEME_PRESETS.filter((p) => p.mode === "light").map((preset) => {
                  const isActive = activePreset === preset.name;
                  return (
                    <button
                      key={preset.name}
                      onClick={() => { if (!isOwner) return; setPrimaryCol(preset.primary); setSecondaryCol(preset.secondary); setTextCol(preset.text); setBgCol(preset.bg); setFontFamily(preset.font); setActivePreset(preset.name); }}
                      disabled={!isOwner}
                      className="flex items-center gap-3 p-3 rounded-2xl border text-left transition-all disabled:opacity-40"
                      style={{
                        borderColor: isActive ? hex(preset.primary, 0.6) : "rgba(0,0,0,0.08)",
                        background: isActive ? hex(preset.primary, 0.08) : "rgba(0,0,0,0.02)",
                      }}
                    >
                      <div className="relative w-9 h-9 shrink-0">
                        <div className="absolute inset-0 rounded-xl border border-black/10" style={{ background: preset.bg }} />
                        <div className="absolute bottom-0.5 right-0.5 w-4 h-4 rounded-md" style={{ background: preset.primary }} />
                        <div className="absolute bottom-0.5 left-0.5 w-3 h-3 rounded-md" style={{ background: preset.secondary, opacity: 0.7 }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-semibold truncate">{preset.name}</p>
                        <p className="text-gray-600 text-[9px] truncate">{preset.style} · {preset.fontLabel}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Fine-tune colours (after a preset is selected) */}
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-3">Fine-tune Colours</label>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Primary",    val: primaryCol,   set: setPrimaryCol,   hint: "Buttons & highlights" },
                { label: "Secondary",  val: secondaryCol, set: setSecondaryCol, hint: "Accents & borders" },
                { label: "Text",       val: textCol,      set: setTextCol,      hint: "Text on primary colour" },
                { label: "App Background", val: bgCol,    set: setBgCol,        hint: "Member app background (dark/light)" },
              ].map(({ label, val, set, hint }) => (
                <div key={label}>
                  <label className="text-gray-400 text-xs font-medium block mb-1">{label}</label>
                  <p className="text-gray-600 text-[10px] mb-1.5">{hint}</p>
                  <div className="flex items-center gap-2">
                    <input type="color" value={val} onChange={(e) => { set(e.target.value); setActivePreset(null); }} disabled={!isOwner}
                      className="w-9 h-9 rounded-lg cursor-pointer border border-black/10 shrink-0" style={{ padding: 2 }} />
                    <input className={inputCls} value={val} onChange={(e) => { set(e.target.value); setActivePreset(null); }} disabled={!isOwner} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Font picker */}
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Club Font</label>
            <p className="text-gray-600 text-[10px] mb-2">Font used throughout the member app</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { codename: "Clean & Pro",         realName: "Inter",            font: "'Inter', sans-serif",            sample: "Train Hard. Tap Harder.",  vibe: "Modern · Neutral" },
                { codename: "Bold & Striker",      realName: "Oswald",           font: "'Oswald', sans-serif",           sample: "TRAIN HARD. TAP HARDER.",  vibe: "Condensed · Athletic" },
                { codename: "Classic & Prestige",  realName: "Montserrat",       font: "'Montserrat', sans-serif",       sample: "Train Hard. Tap Harder.",  vibe: "Geometric · Established" },
                { codename: "Tech & Modern",       realName: "Space Grotesk",    font: "'Space Grotesk', sans-serif",    sample: "Train Hard. Tap Harder.",  vibe: "High-contrast · Digital" },
                { codename: "Combat & Industrial", realName: "Rajdhani",         font: "'Rajdhani', sans-serif",         sample: "TRAIN HARD. TAP HARDER.",  vibe: "Military · No-nonsense" },
                { codename: "Elegant & Tradition", realName: "Playfair Display", font: "'Playfair Display', serif",      sample: "Train Hard. Tap Harder.",  vibe: "Serif · Luxury" },
              ].map(({ codename, realName, font, sample, vibe }) => (
                <button
                  key={realName}
                  onClick={() => { if (!isOwner) return; setFontFamily(font); setActivePreset(null); }}
                  disabled={!isOwner}
                  className="p-3 rounded-xl border text-left transition-all disabled:opacity-40"
                  style={{
                    borderColor: fontFamily === font ? hex(primaryCol, 0.5) : "rgba(0,0,0,0.08)",
                    background: fontFamily === font ? hex(primaryCol, 0.08) : "rgba(0,0,0,0.02)",
                  }}
                >
                  <p className="text-white text-[11px] font-bold tracking-wide" style={{ fontFamily: font }}>{codename}</p>
                  <p className="text-gray-600 text-[9px] mt-0.5">{realName}</p>
                  <p className="text-[9px] mt-0.5" style={{ color: hex(primaryCol, 0.7) }}>{vibe}</p>
                  <p className="text-gray-500 text-[9px] mt-1.5 truncate" style={{ fontFamily: font }}>{sample}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Logo background fill */}
          {logoPreview && (
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">Logo Background Fill</label>
              <p className="text-gray-600 text-[10px] mb-2">If your logo has a coloured or transparent background, fill it so the text reads clearly.</p>
              <div className="flex gap-2">
                {(["none", "black", "white"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setLogoBg(opt)}
                    disabled={!isOwner}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium capitalize transition-all"
                    style={{
                      borderColor: logoBg === opt ? hex(primaryCol, 0.5) : "rgba(255,255,255,0.1)",
                      background: logoBg === opt ? hex(primaryCol, 0.1) : "rgba(0,0,0,0.02)",
                      color: logoBg === opt ? primaryCol : "rgba(255,255,255,0.5)",
                    }}
                  >
                    {opt === "none" ? "None (transparent)" : opt === "black" ? "Black fill" : "White fill"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Live phone preview */}
          {isOwner && (
            <button onClick={saveBranding} disabled={saving}
              className="w-full py-3 rounded-xl text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: primaryCol }}
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Branding
            </button>
          )}
          </div>{/* end left column */}

          {/* ── Right: fixed phone preview ── */}
          <div className="w-[300px] shrink-0 hidden xl:flex" style={{ position: "sticky", top: 0, height: "calc(100vh - 120px)", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              {/* Header */}
              <div className="flex items-center justify-between mb-3 px-1 w-full">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: hex(primaryCol, 0.7) }}>iPhone · 390pt</span>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ background: hex(primaryCol, 0.08), border: `1px solid ${hex(primaryCol, 0.2)}` }}>
                  <span className="w-1 h-1 rounded-full" style={{ background: primaryCol }} />
                  <span className="text-[9px] font-mono uppercase tracking-[0.1em]" style={{ color: primaryCol }}>Preview</span>
                </div>
              </div>
              {/* Phone frame */}
              <div
                className="relative mx-auto rounded-[2.8rem] p-2.5 shadow-2xl"
                style={{
                  width: 280,
                  height: 580,
                  background: "#0a0a0a",
                  boxShadow: "0 40px 80px -20px rgba(0,0,0,0.9), 0 0 0 8px #1a1a1a",
                  flexShrink: 0,
                }}
              >
                {/* Notch */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-5 bg-black rounded-b-2xl z-30" />
                {/* Screen */}
                <div className="w-full h-full rounded-[2.2rem] overflow-hidden">
                  <PhonePreview gymName={gymName} primaryCol={primaryCol} logoPreview={logoPreview} logoBg={logoBg} logoSize={logoSize} bgCol={bgCol} fontFamily={fontFamily} />
                </div>
              </div>
          </div>
        </div>
      )}

      {/* ── Revenue ── */}
      {tab === "revenue" && (
        <div className="space-y-5">

          {/* ── Stripe Connect section ── */}
          {isOwner && (
            <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-white font-semibold text-sm">Stripe Connect</p>
                  {stripeIsConnected ? (
                    <p className="text-gray-500 text-xs mt-1">
                      Payments go directly to your Stripe account.
                      {stripeAccount && <span className="ml-1 text-gray-400 font-mono">{stripeAccount}</span>}
                    </p>
                  ) : (
                    <p className="text-gray-500 text-xs mt-1">Connect your Stripe account so members pay you directly — MatFlow never holds your funds.</p>
                  )}
                </div>
                {stripeIsConnected ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                      Connected
                    </span>
                    <button
                      onClick={disconnectStripe}
                      disabled={stripeDisconnecting}
                      className="px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors"
                      style={{ borderColor: "rgba(239,68,68,0.3)", color: "#ef4444", background: "rgba(239,68,68,0.06)" }}
                    >
                      {stripeDisconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : "Disconnect"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={connectStripe}
                    className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-opacity hover:opacity-90"
                    style={{ background: primaryColor }}
                  >
                    <ExternalLink className="w-4 h-4" />
                    Connect Stripe
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── BACS Direct Debit toggle ── */}
          {isOwner && stripeIsConnected && (
            <BacsToggle
              initialAccepts={settings?.acceptsBacs ?? false}
              primaryColor={primaryCol}
            />
          )}

          {/* ── Member self-billing toggle + contact fields ── */}
          {isOwner && (
            <MemberSelfBillingSection
              initialEnabled={settings?.memberSelfBilling ?? false}
              initialEmail={settings?.billingContactEmail ?? null}
              initialUrl={settings?.billingContactUrl ?? null}
              primaryColor={primaryCol}
            />
          )}

          {/* ── Privacy contact + policy URL (Sprint 3 L) ── */}
          {isOwner && (
            <PrivacySection
              initialEmail={settings?.privacyContactEmail ?? null}
              initialUrl={settings?.privacyPolicyUrl ?? null}
              primaryColor={primaryCol}
            />
          )}

          {/* ── Socials + website (Sprint 3 L) ── */}
          {isOwner && (
            <SocialsSection
              initial={{
                instagramUrl: settings?.instagramUrl ?? null,
                facebookUrl: settings?.facebookUrl ?? null,
                tiktokUrl: settings?.tiktokUrl ?? null,
                youtubeUrl: settings?.youtubeUrl ?? null,
                twitterUrl: settings?.twitterUrl ?? null,
                websiteUrl: settings?.websiteUrl ?? null,
              }}
              primaryColor={primaryCol}
            />
          )}

          {/* ── Subscription Plans (visible when connected) ── */}
          {isOwner && stripeIsConnected && (
            <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
              <div className="flex items-center justify-between mb-4">
                <p className="text-white font-semibold text-sm">Subscription Plans</p>
                <button
                  onClick={() => setPlanDrawer(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-white text-xs font-semibold"
                  style={{ background: primaryColor }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Plan
                </button>
              </div>
              {!plansLoaded ? (
                <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-gray-500" /></div>
              ) : plans.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-4">No plans yet — add one to start selling memberships.</p>
              ) : (
                <div className="space-y-2">
                  {plans.map((p) => (
                    <div key={p.id} className="flex items-center justify-between py-2.5 border-b last:border-0" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                      <div>
                        <p className="text-white text-sm font-medium">{p.name}</p>
                        <p className="text-gray-500 text-xs mt-0.5">per {p.interval}</p>
                      </div>
                      <span className="text-white font-semibold text-sm">
                        {p.currency === "gbp" ? "£" : p.currency.toUpperCase()}{p.amount.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Demo revenue chart (sample data) ── */}
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-blue-400 text-sm">
            {stripeIsConnected
              ? "Live data captured via webhook — chart below is sample data until webhooks populate."
              : "Connect Stripe above to capture live revenue data. Figures below are demo data."}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Monthly Revenue",  value: `£${revenue.mrr.toLocaleString()}`,  sub: "+12% vs last month", color: "#10b981" },
              { label: "Annual Run Rate", value: `£${revenue.arr.toLocaleString()}`,  sub: "projected",           color: "#3b82f6" },
              { label: "Active Members",  value: revenue.activeMembers,                sub: "paying members",     color: "#8b5cf6" },
              { label: "Avg per Member",  value: `£${revenue.avgPerMember}`,           sub: "per month",          color: "#f59e0b" },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="rounded-2xl border p-4" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
                <p className="text-white text-2xl font-bold">{value}</p>
                <p className="text-gray-500 text-xs mt-1">{label}</p>
                <p className="text-xs mt-0.5" style={{ color }}>{sub}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Monthly Revenue</h2>
            <div className="flex items-end gap-2 h-32">
              {revenue.history.map(({ month, revenue }) => (
                <div key={month} className="flex-1 flex flex-col items-center gap-1.5">
                  <span className="text-gray-600 text-[9px]">£{revenue}</span>
                  <div
                    className="w-full rounded-t-lg transition-all"
                    style={{
                      height: `${(revenue / maxRevenue) * 90}%`,
                      background: hex(primaryColor, 0.7),
                      minHeight: 4,
                    }}
                  />
                  <span className="text-gray-500 text-[9px]">{month}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Membership Tiers</h2>
            <div className="space-y-3">
              {revenue.memberships.map(({ name, price, count, color }) => (
                <div key={name} className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <span className="text-gray-300 text-sm">{name} · £{price}/mo</span>
                      <span className="text-white text-sm font-semibold">{count} members</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.08)" }}>
                      <div className="h-full rounded-full" style={{ width: `${(count / Math.max(1, revenue.activeMembers)) * 100}%`, background: color }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Recent Activity</h2>
            <div className="space-y-3">
              {revenue.recent.map(({ name, action, tier, date }, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: action === "joined" ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)" }}>
                    <TrendingUp className="w-4 h-4" style={{ color: action === "joined" ? "#10b981" : "#ef4444" }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-white text-sm font-medium">{name}</p>
                    <p className="text-gray-500 text-xs">{action === "joined" ? "Joined" : "Cancelled"} · {tier}</p>
                  </div>
                  <span className="text-gray-600 text-xs shrink-0">{date}</span>
                </div>
              ))}
            </div>
          </div>

          {isOwner && stripeIsConnected && (
            <ClassPacksManager primaryColor={primaryCol} />
          )}

          <PaymentsTable primaryColor={primaryColor} />
        </div>
      )}

      {/* ── Store ── */}
      {tab === "store" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white font-semibold text-sm">Club Store</p>
              <p className="text-gray-500 text-xs mt-0.5">Members can purchase items at the gym through the app</p>
            </div>
            {isOwner && (
              <button onClick={openAddProduct}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold"
                style={{ background: primaryColor }}
              >
                <Plus className="w-4 h-4" /> Add Item
              </button>
            )}
          </div>

          {/* Category breakdown */}
          <div className="grid grid-cols-3 gap-2">
            {(["clothing", "food", "drink", "equipment", "other"] as const).map((cat) => {
              const count = products.filter((p) => p.category === cat).length;
              if (count === 0) return null;
              const labels = { clothing: "Clothing", food: "Food", drink: "Drinks", equipment: "Equipment", other: "Other" };
              return (
                <div key={cat} className="rounded-xl border p-3 text-center" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
                  <p className="text-white font-bold text-lg">{count}</p>
                  <p className="text-gray-500 text-xs">{labels[cat]}</p>
                </div>
              );
            })}
          </div>

          {/* Product list */}
          <div className="space-y-2">
            {products.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3 rounded-2xl border" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)", opacity: p.inStock ? 1 : 0.5 }}>
                <span className="text-2xl shrink-0">{p.emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-white text-sm font-semibold truncate">{p.name}</p>
                    {!p.inStock && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400">Out of stock</span>}
                  </div>
                  <p className="text-gray-500 text-xs capitalize">{p.category}</p>
                </div>
                <p className="text-white font-bold text-sm shrink-0">£{p.price.toFixed(2)}</p>
                {isOwner && (
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => openEditProduct(p)} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-colors"><Edit2 className="w-3.5 h-3.5" /></button>
                    <button onClick={() => deleteProduct(p.id)} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {products.length === 0 && (
            <div className="text-center py-12">
              <Package className="w-10 h-10 text-gray-700 mx-auto mb-3" />
              <p className="text-gray-600 text-sm">No products yet</p>
              <p className="text-gray-700 text-xs mt-1">Add items for members to purchase at the gym</p>
            </div>
          )}

          {/* Store link */}
          {products.length > 0 && (
            <div className="rounded-2xl border p-4" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
              <p className="text-gray-400 text-xs mb-2">Members access the store via the member app. Checkout is processed at the gym.</p>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <div className="w-2 h-2 rounded-full bg-green-400" />
                Store active · {products.filter((p) => p.inStock).length} items available
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Staff ── */}
      {tab === "staff" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-gray-400 text-sm">{staff.length} team member{staff.length !== 1 ? "s" : ""}</p>
            {isOwner && (
              <button onClick={openAddStaff} className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold" style={{ background: primaryColor }}>
                <Plus className="w-4 h-4" /> Add Staff
              </button>
            )}
          </div>
          <div className="space-y-2">
            {staff.map((m) => (
              <StaffCard key={m.id} member={m} canEdit={isOwner} onEdit={openEditStaff} onDelete={handleStaffDelete} isSelf={m.id === currentUserId} />
            ))}
          </div>
          {staff.length === 0 && <div className="text-center py-12"><p className="text-gray-600 text-sm">No staff members yet</p></div>}
        </div>
      )}

      {/* ── Account ── */}
      {tab === "account" && (
        <div className="space-y-4">

          {/* TOTP card — owner only */}
          {isOwner && (
            <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
              <h2 className="font-semibold text-sm mb-1" style={{ color: "var(--tx-1)" }}>Two-Factor Authentication</h2>
              <p className="text-xs mb-4" style={{ color: "var(--tx-3)" }}>
                Require an authenticator app code on every owner login for extra security.
              </p>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4" style={{ color: mfaEnabled ? "#10b981" : "var(--tx-3)" }} />
                  <span className="text-sm font-medium" style={{ color: "var(--tx-2)" }}>Authenticator App</span>
                  {mfaEnabled && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
                      <Check className="w-2.5 h-2.5" /> Enabled
                    </span>
                  )}
                </div>
                {mfaEnabled ? (
                  <button
                    onClick={() => { setDisableCode(""); setDisableError(""); setTotpDisableDrawer(true); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors"
                    style={{ borderColor: "rgba(239,68,68,0.25)", color: "#ef4444", background: "rgba(239,68,68,0.06)" }}
                  >
                    Disable
                  </button>
                ) : (
                  <button
                    onClick={openTotpSetup}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors"
                    style={{ background: primaryColor }}
                  >
                    Set up
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Check-In QR Code</h2>
            <p className="text-gray-500 text-sm mb-3">Share this URL with members or display as a QR code at your gym entrance.</p>
            <div className="flex items-center gap-2 p-3 rounded-xl border border-black/10" style={{ background: "rgba(0,0,0,0.02)" }}>
              <code className="flex-1 text-blue-400 text-sm truncate">
                {typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/checkin/{settings?.slug}
              </code>
              <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/checkin/${settings?.slug}`); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: copied ? hex("#10b981", 0.15) : "rgba(0,0,0,0.08)" }}
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-400" />}
              </button>
              <a href={`/checkin/${settings?.slug}`} target="_blank" rel="noreferrer"
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                style={{ background: "rgba(0,0,0,0.08)" }}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Subscription</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-semibold">{settings ? TIER_LABELS[settings.subscriptionTier] : "—"} Plan</p>
                <p className="text-gray-500 text-sm capitalize">{settings?.subscriptionStatus}</p>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-semibold" style={{ background: hex(primaryColor, 0.15), color: primaryColor }}>
                {settings?.subscriptionTier?.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="rounded-2xl border border-red-500/10 p-5" style={{ background: "rgba(239,68,68,0.03)" }}>
            <h2 className="text-red-400 font-semibold text-sm mb-2">Danger Zone</h2>
            <p className="text-gray-500 text-sm mb-4">Contact support to cancel your subscription or export all data.</p>
            <a href="mailto:hello@matflow.io" className="text-red-400 text-sm hover:text-red-300 transition-colors">Contact support →</a>
          </div>
        </div>
      )}

      {/* ── Waiver ── */}
      {tab === "waiver" && (
        <div className="space-y-4">
          <div className="rounded-2xl border p-5" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Liability Waiver</h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
                  Shown to members during onboarding. Customise the title and text for your gym.
                </p>
              </div>
              <span
                className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold"
                style={
                  waiverTitle || waiverContent
                    ? { background: "rgba(52,211,153,0.12)", color: "#34d399" }
                    : { background: "rgba(148,163,184,0.12)", color: "#94a3b8" }
                }
              >
                {waiverTitle || waiverContent ? "Custom waiver" : "Using default"}
              </span>
            </div>

            {waiverEditing ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Waiver title</label>
                  <input
                    value={waiverTitle}
                    onChange={(e) => setWaiverTitle(e.target.value)}
                    placeholder="Liability Waiver & Assumption of Risk"
                    className={inputCls}
                    maxLength={200}
                  />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Waiver content</label>
                  <textarea
                    value={waiverContent}
                    onChange={(e) => setWaiverContent(e.target.value)}
                    placeholder="Enter your waiver text…"
                    rows={12}
                    maxLength={20000}
                    className="w-full bg-transparent border border-black/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-white/30 transition-colors resize-none"
                  />
                  <p className="text-xs mt-1 text-right" style={{ color: "var(--tx-4)" }}>{waiverContent.length}/20,000</p>
                </div>
                <div className="flex gap-3 pt-1">
                  <button
                    onClick={async () => {
                      setWaiverSaving(true);
                      try {
                        const res = await fetch("/api/settings", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ waiverTitle: waiverTitle || null, waiverContent: waiverContent || null }),
                        });
                        if (!res.ok) { toast("Failed to save waiver", "error"); return; }
                        setWaiverEditing(false);
                        toast("Waiver saved", "success");
                      } finally { setWaiverSaving(false); }
                    }}
                    disabled={waiverSaving}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60"
                    style={{ background: primaryColor }}
                  >
                    {waiverSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {waiverSaving ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={() => { setWaiverEditing(false); setWaiverTitle(settings?.waiverTitle ?? ""); setWaiverContent(settings?.waiverContent ?? ""); }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm border"
                    style={{ color: "var(--tx-3)", borderColor: "rgba(0,0,0,0.1)" }}
                  >
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  {(waiverTitle || waiverContent) && (
                    <button
                      onClick={async () => {
                        if (!confirm("Reset to default waiver text?")) return;
                        setWaiverSaving(true);
                        try {
                          await fetch("/api/settings", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ waiverTitle: null, waiverContent: null }),
                          });
                          setWaiverTitle("");
                          setWaiverContent("");
                          setWaiverEditing(false);
                          toast("Reset to default waiver", "success");
                        } finally { setWaiverSaving(false); }
                      }}
                      className="ml-auto px-4 py-2 rounded-xl text-xs border"
                      style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.04)" }}
                    >
                      Reset to Default
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div
                  className="rounded-xl border p-4 h-48 overflow-y-auto text-xs leading-relaxed space-y-2"
                  style={{ background: "rgba(0,0,0,0.03)", borderColor: "rgba(0,0,0,0.08)", color: "var(--tx-3)" }}
                >
                  <p className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>
                    {waiverTitle || "Liability Waiver & Assumption of Risk"}
                  </p>
                  {(waiverContent || "I acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver, I voluntarily accept all risks associated with training and participation at this facility.\n\nI agree to follow all gym rules, coach instructions, and safety guidelines at all times. I confirm that I am physically fit to participate and have disclosed any known medical conditions or injuries that may affect my training.\n\nI release the gym, its owners, coaches, staff, and affiliates from any liability for injury, loss, or damage arising from my participation, except in cases of gross negligence or wilful misconduct.\n\nThis waiver applies to all activities on the premises including classes, open mat sessions, and any gym-organised events.\n\nI confirm I have read this waiver, understand its contents, and agree to be bound by its terms.")
                    .split("\n\n").map((para, i) => <p key={i}>{para}</p>)}
                </div>
                <button
                  onClick={() => setWaiverEditing(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white"
                  style={{ background: primaryColor }}
                >
                  <Edit2 className="w-4 h-4" /> Edit Waiver
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Integrations ── */}
      {tab === "integrations" && (
        <IntegrationsTab primaryColor={primaryColor} />
      )}

      {/* ── Staff drawer ── */}
      <Drawer open={staffDrawer} title={editStaff ? "Edit Staff Member" : "Add Staff Member"} onClose={() => setStaffDrawer(false)}>
        {tempPassword ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-green-500/20 p-4" style={{ background: "rgba(16,185,129,0.07)" }}>
              <p className="text-green-400 font-semibold text-sm mb-1">✅ Staff member added!</p>
              <p className="text-gray-400 text-sm">Share these login credentials:</p>
            </div>
            <div className="space-y-2">
              {[
                { label: "Club Code", value: settings?.slug },
                { label: "Email", value: sfEmail },
                { label: "Temporary Password", value: tempPassword, yellow: true },
              ].map(({ label, value, yellow }) => (
                <div key={label} className="p-3 rounded-xl border border-black/10" style={{ background: "rgba(0,0,0,0.02)" }}>
                  <p className="text-gray-500 text-xs mb-1">{label}</p>
                  <p className={`font-mono text-sm ${yellow ? "text-yellow-400" : "text-white"}`}>{value}</p>
                </div>
              ))}
            </div>
            <p className="text-gray-600 text-xs">Ask them to change their password after first login.</p>
            <button onClick={() => setStaffDrawer(false)} className="w-full py-3 rounded-xl text-white font-semibold" style={{ background: primaryColor }}>Done</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">Full Name *</label>
              <input className={inputCls} value={sfName} onChange={(e) => setSfName(e.target.value)} placeholder="Coach Mike" />
            </div>
            {!editStaff && (
              <div>
                <label className="text-gray-400 text-xs font-medium block mb-1.5">Email *</label>
                <input type="email" className={inputCls} value={sfEmail} onChange={(e) => setSfEmail(e.target.value)} placeholder="coach@yourgym.com" />
              </div>
            )}
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">Role *</label>
              <select className={inputCls} value={sfRole} onChange={(e) => setSfRole(e.target.value as "manager" | "coach" | "admin")} style={{ appearance: "auto" }}>
                <option value="manager" style={{ background: "var(--sf-1)" }}>Manager — all access except billing</option>
                <option value="coach"   style={{ background: "var(--sf-1)" }}>Coach — attendance + members</option>
                <option value="admin"   style={{ background: "var(--sf-1)" }}>Admin — check-in + front desk</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">{editStaff ? "New Password (leave blank to keep)" : "Password (leave blank to auto-generate)"}</label>
              <input type="password" className={inputCls} value={sfPassword} onChange={(e) => setSfPassword(e.target.value)} placeholder={editStaff ? "••••••••" : "auto-generated"} />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setStaffDrawer(false)} className="flex-1 py-2.5 rounded-xl border border-black/10 text-gray-400 text-sm font-medium hover:text-white transition-colors">Cancel</button>
              <button onClick={handleStaffSave} disabled={!sfName.trim() || (!editStaff && !sfEmail.trim()) || sfSaving}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {sfSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editStaff ? "Save Changes" : "Add Staff"}
              </button>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── Product drawer ── */}
      <Drawer open={productDrawer} title={editProduct ? "Edit Product" : "Add Product"} onClose={() => setProductDrawer(false)}>
        <div className="space-y-4">
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Product Name *</label>
            <input className={inputCls} value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Club T-Shirt" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">Price (£) *</label>
              <input type="number" step="0.01" className={inputCls} value={pPrice} onChange={(e) => setPPrice(e.target.value)} placeholder="25.00" />
            </div>
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">Symbol</label>
              <input className={inputCls} value={pEmoji} onChange={(e) => setPEmoji(e.target.value)} placeholder="👕" />
            </div>
          </div>
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Category</label>
            <select className={inputCls} value={pCat} onChange={(e) => setPCat(e.target.value as StoreProduct["category"])} style={{ appearance: "auto" }}>
              <option value="clothing"  style={{ background: "var(--sf-1)" }}>Clothing</option>
              <option value="food"      style={{ background: "var(--sf-1)" }}>Food</option>
              <option value="drink"     style={{ background: "var(--sf-1)" }}>Drinks</option>
              <option value="equipment" style={{ background: "var(--sf-1)" }}>Equipment</option>
              <option value="other"     style={{ background: "var(--sf-1)" }}>Other</option>
            </select>
          </div>
          <div className="flex items-center justify-between p-3 rounded-xl border border-black/10" style={{ background: "rgba(0,0,0,0.02)" }}>
            <span className="text-white text-sm">In Stock</span>
            <button
              onClick={() => setPStock((v) => !v)}
              className="w-10 h-6 rounded-full transition-all relative"
              style={{ background: pStock ? primaryColor : "rgba(255,255,255,0.1)" }}
            >
              <div className="w-4 h-4 bg-white rounded-full absolute top-1 transition-all" style={{ left: pStock ? "calc(100% - 20px)" : 4 }} />
            </button>
          </div>
          <div className="flex gap-3 pt-2">
            <button onClick={() => setProductDrawer(false)} className="flex-1 py-2.5 rounded-xl border border-black/10 text-gray-400 text-sm font-medium hover:text-white transition-colors">Cancel</button>
            <button onClick={saveProduct} disabled={!pName.trim() || !pPrice || productSaving}
              className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
              style={{ background: primaryColor }}
            >
              {productSaving ? "Saving…" : editProduct ? "Save" : "Add Product"}
            </button>
          </div>
        </div>
      </Drawer>

      {/* ── TOTP setup drawer ── */}
      <Drawer open={totpSetupDrawer} title="Set up Authenticator" onClose={() => setTotpSetupDrawer(false)}>
        {totpStep === 1 ? (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "var(--tx-2)" }}>
              Scan this QR code with <strong>Google Authenticator</strong>, <strong>Microsoft Authenticator</strong>, or any TOTP app.
            </p>
            {totpSaving ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--tx-3)" }} />
              </div>
            ) : totpQrUrl ? (
              <div className="flex flex-col items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={totpQrUrl} alt="TOTP QR code" className="rounded-xl" style={{ width: 180, height: 180 }} />
                <div className="w-full p-3 rounded-xl border border-black/10 text-center" style={{ background: "rgba(0,0,0,0.02)" }}>
                  <p className="text-xs mb-1" style={{ color: "var(--tx-3)" }}>Manual key</p>
                  <code className="text-xs font-mono break-all" style={{ color: "var(--tx-1)" }}>{totpSecret}</code>
                </div>
              </div>
            ) : (
              <p className="text-red-400 text-sm">{totpError || "Failed to load QR code."}</p>
            )}
            <button
              onClick={() => setTotpStep(2)}
              disabled={!totpQrUrl}
              className="w-full py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-30"
              style={{ background: primaryColor }}
            >
              I&apos;ve scanned it →
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "var(--tx-2)" }}>
              Enter the 6-digit code from your authenticator app to confirm setup.
            </p>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={totpCode}
              onChange={(e) => { setTotpCode(e.target.value.replace(/\D/g, "")); setTotpError(""); }}
              placeholder="000000"
              className="w-full text-center text-xl font-mono tracking-[0.4em] py-3 rounded-xl outline-none border transition-all"
              style={{
                background: "rgba(0,0,0,0.02)",
                borderColor: totpError ? "#ef4444" : "rgba(0,0,0,0.1)",
                color: "var(--tx-1)",
              }}
              autoFocus
            />
            {totpError && <p className="text-red-400 text-sm text-center">{totpError}</p>}
            <div className="flex gap-3">
              <button onClick={() => setTotpStep(1)} className="flex-1 py-2.5 rounded-xl border border-black/10 text-sm font-medium" style={{ color: "var(--tx-3)" }}>
                Back
              </button>
              <button
                onClick={confirmTotpSetup}
                disabled={totpCode.length !== 6 || totpSaving}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-30 flex items-center justify-center gap-2"
                style={{ background: primaryColor }}
              >
                {totpSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                Verify & Enable
              </button>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── TOTP disable drawer ── */}
      <Drawer open={totpDisableDrawer} title="Disable Two-Factor Auth" onClose={() => setTotpDisableDrawer(false)}>
        <div className="space-y-4">
          <p className="text-sm" style={{ color: "var(--tx-2)" }}>
            Enter your current authenticator code to confirm you want to disable 2FA.
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={disableCode}
            onChange={(e) => { setDisableCode(e.target.value.replace(/\D/g, "")); setDisableError(""); }}
            placeholder="000000"
            className="w-full text-center text-xl font-mono tracking-[0.4em] py-3 rounded-xl outline-none border transition-all"
            style={{
              background: "rgba(0,0,0,0.02)",
              borderColor: disableError ? "#ef4444" : "rgba(0,0,0,0.1)",
              color: "var(--tx-1)",
            }}
            autoFocus
          />
          {disableError && <p className="text-red-400 text-sm text-center">{disableError}</p>}
          <div className="flex gap-3">
            <button onClick={() => setTotpDisableDrawer(false)} className="flex-1 py-2.5 rounded-xl border border-black/10 text-sm font-medium" style={{ color: "var(--tx-3)" }}>
              Cancel
            </button>
            <button
              onClick={confirmTotpDisable}
              disabled={disableCode.length !== 6 || disableSaving}
              className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-30 flex items-center justify-center gap-2"
              style={{ background: "#ef4444" }}
            >
              {disableSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              Disable 2FA
            </button>
          </div>
        </div>
      </Drawer>

      {/* ── Add Plan drawer ── */}
      <Drawer open={planDrawer} title="Add Subscription Plan" onClose={() => setPlanDrawer(false)}>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-2)" }}>Plan name</label>
            <input
              type="text"
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              placeholder="e.g. Monthly Unlimited"
              className="w-full px-3 py-2.5 rounded-xl border outline-none text-sm transition-all"
              style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.1)", color: "var(--tx-1)" }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-2)" }}>Price (£)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={planPrice}
              onChange={(e) => setPlanPrice(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 rounded-xl border outline-none text-sm transition-all"
              style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.1)", color: "var(--tx-1)" }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-2)" }}>Billing interval</label>
            <div className="flex gap-2">
              {(["month", "year"] as const).map((iv) => (
                <button
                  key={iv}
                  onClick={() => setPlanInterval(iv)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all"
                  style={{
                    background: planInterval === iv ? primaryColor : "rgba(0,0,0,0.02)",
                    borderColor: planInterval === iv ? primaryColor : "rgba(0,0,0,0.1)",
                    color: planInterval === iv ? "#fff" : "var(--tx-2)",
                  }}
                >
                  {iv === "month" ? "Monthly" : "Annual"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={() => setPlanDrawer(false)} className="flex-1 py-2.5 rounded-xl border border-black/10 text-sm font-medium" style={{ color: "var(--tx-3)" }}>
              Cancel
            </button>
            <button
              onClick={createPlan}
              disabled={!planName.trim() || !planPrice || Number(planPrice) <= 0 || planSaving}
              className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-30 flex items-center justify-center gap-2"
              style={{ background: primaryColor }}
            >
              {planSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Plan
            </button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}

// ─── Sprint 3 L: Privacy contact + policy URL ────────────────────────────────

function PrivacySection({
  initialEmail,
  initialUrl,
  primaryColor,
}: {
  initialEmail: string | null;
  initialUrl: string | null;
  primaryColor: string;
}) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          privacyContactEmail: email.trim() || null,
          privacyPolicyUrl: url.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update");
        return;
      }
      toast("Privacy contact saved", "success");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5 space-y-3" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
      <div>
        <p className="text-white font-semibold text-sm">Privacy contact</p>
        <p className="text-gray-500 text-xs mt-1">
          Shown inside the member portal as the data-controller contact. The public legal page stays SaaS-level.
        </p>
      </div>
      <div className="space-y-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="privacy@yourgym.com"
          className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none focus:border-white/20"
          style={{ borderColor: "rgba(255,255,255,0.1)" }}
        />
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://yourgym.com/privacy"
          className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none focus:border-white/20"
          style={{ borderColor: "rgba(255,255,255,0.1)" }}
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
        style={{ background: primaryColor }}
      >
        {saving ? "Saving…" : "Save privacy details"}
      </button>
    </div>
  );
}

// ─── Sprint 3 L: Socials + website ───────────────────────────────────────────

const SOCIAL_FIELDS = [
  { key: "instagramUrl",  label: "Instagram",  placeholder: "https://instagram.com/yourgym" },
  { key: "facebookUrl",   label: "Facebook",   placeholder: "https://facebook.com/yourgym" },
  { key: "tiktokUrl",     label: "TikTok",     placeholder: "https://tiktok.com/@yourgym" },
  { key: "youtubeUrl",    label: "YouTube",    placeholder: "https://youtube.com/@yourgym" },
  { key: "twitterUrl",    label: "Twitter / X",placeholder: "https://x.com/yourgym" },
  { key: "websiteUrl",    label: "Website",    placeholder: "https://yourgym.com" },
] as const;

type SocialKey = typeof SOCIAL_FIELDS[number]["key"];
type SocialState = Record<SocialKey, string | null>;

function SocialsSection({
  initial,
  primaryColor,
}: {
  initial: SocialState;
  primaryColor: string;
}) {
  const [state, setState] = useState<SocialState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const patch = Object.fromEntries(
        SOCIAL_FIELDS.map(({ key }) => [key, (state[key] ?? "").trim() || null]),
      );
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to update — URLs must be https://");
        return;
      }
      toast("Socials saved", "success");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5 space-y-3" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
      <div>
        <p className="text-white font-semibold text-sm">Socials & website</p>
        <p className="text-gray-500 text-xs mt-1">Shown in the member-portal gym card. URLs must start with https://.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {SOCIAL_FIELDS.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">{label}</label>
            <input
              type="url"
              value={state[key] ?? ""}
              onChange={(e) => setState((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-700 outline-none focus:border-white/20"
              style={{ borderColor: "rgba(255,255,255,0.1)" }}
            />
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={save}
        disabled={saving}
        className="px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
        style={{ background: primaryColor }}
      >
        {saving ? "Saving…" : "Save socials"}
      </button>
    </div>
  );
}
