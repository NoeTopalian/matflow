"use client";

import { useState, useRef, useEffect } from "react";
import {
  Settings, Users, Palette, Shield, Plus, Trash2,
  Edit2, X, Loader2, Copy, Check, ExternalLink,
  Crown, User, ChevronRight, UploadCloud, ShoppingBag,
  DollarSign, TrendingUp, Package, LayoutDashboard, Bell,
  Home, Calendar,
} from "lucide-react";
import Image from "next/image";
import { useToast } from "@/components/ui/Toast";
import type { TenantSettings, StaffMember } from "@/app/dashboard/settings/page";

interface Props {
  settings: TenantSettings | null;
  staff: StaffMember[];
  statusCounts: Record<string, number>;
  primaryColor: string;
  role: string;
  currentUserId: string;
}

type Tab = "overview" | "branding" | "revenue" | "store" | "staff" | "account";

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

const DEMO_REVENUE = {
  mrr: 1280,
  arr: 15360,
  activeMembers: 18,
  avgPerMember: 71,
  growth: 12,
  history: [
    { month: "Oct", revenue: 960 },
    { month: "Nov", revenue: 1040 },
    { month: "Dec", revenue: 960 },
    { month: "Jan", revenue: 1120 },
    { month: "Feb", revenue: 1200 },
    { month: "Mar", revenue: 1280 },
  ],
  memberships: [
    { name: "Monthly",  price: 60,  count: 14, color: "#3b82f6" },
    { name: "Annual",   price: 600, count: 3,  color: "#10b981" },
    { name: "Student",  price: 45,  count: 1,  color: "#8b5cf6" },
  ],
  recent: [
    { name: "James K.",   action: "joined",    tier: "Monthly",  date: "2d ago" },
    { name: "Sophie T.",  action: "joined",    tier: "Annual",   date: "5d ago" },
    { name: "Mark R.",    action: "cancelled", tier: "Monthly",  date: "1w ago" },
    { name: "Hannah L.",  action: "joined",    tier: "Student",  date: "1w ago" },
  ],
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
      <div className="fixed top-0 right-0 h-full w-full max-w-md z-50 flex flex-col" style={{ background: "#0e1013", borderLeft: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="text-white font-semibold text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400" style={{ background: "rgba(255,255,255,0.07)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </>
  );
}

// ─── Phone preview ────────────────────────────────────────────────────────────

function PhonePreview({ gymName, primaryCol, logoPreview, logoBg, bgCol, fontFamily }: { gymName: string; primaryCol: string; logoPreview: string | null; logoBg?: "none" | "black" | "white"; bgCol?: string; fontFamily?: string }) {
  const bg = bgCol ?? "#111111";
  const font = fontFamily ?? "Inter, sans-serif";
  const isLight = bg.startsWith("#f") || bg.startsWith("#e") || bg === "#ffffff";
  const textPrimary = isLight ? "#0f172a" : "#ffffff";
  const textMuted = isLight ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.4)";
  const borderCol = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
  const surfaceCol = isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)";
  return (
    <div className="flex justify-center py-2">
      <div
        className="relative rounded-[32px] overflow-hidden"
        style={{
          width: 200,
          height: 380,
          background: bg,
          fontFamily: font,
          border: "6px solid #2a2a2a",
          boxShadow: "0 24px 48px rgba(0,0,0,0.6)",
        }}
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
                <img src={logoPreview} alt="logo" className="h-5 object-contain" style={{ maxWidth: 80 }} />
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
    </div>
  );
}

// ─── Staff card ───────────────────────────────────────────────────────────────

function StaffCard({ member, canEdit, onEdit, onDelete, isSelf }: { member: StaffMember; canEdit: boolean; onEdit: (m: StaffMember) => void; onDelete: (id: string) => void; isSelf: boolean }) {
  const meta = ROLE_META[member.role] ?? ROLE_META.admin;
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-2xl border" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPage({ settings, staff: initialStaff, statusCounts, primaryColor, role, currentUserId }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [staff, setStaff] = useState<StaffMember[]>(initialStaff);

  // Branding state
  const localSettings = (() => { try { return JSON.parse(localStorage.getItem("gym-settings") ?? "{}"); } catch { return {}; } })();
  const [gymName, setGymName]           = useState(settings?.name ?? "");
  const [primaryCol, setPrimaryCol]     = useState(localSettings.primaryColor   ?? settings?.primaryColor   ?? primaryColor);
  const [secondaryCol, setSecondaryCol] = useState(localSettings.secondaryColor ?? settings?.secondaryColor ?? "#2563eb");
  const [textCol, setTextCol]           = useState(localSettings.textColor      ?? settings?.textColor      ?? "#ffffff");
  const [bgCol, setBgCol]               = useState(localSettings.bgColor        ?? "#111111");
  const [fontFamily, setFontFamily]     = useState(localSettings.fontFamily     ?? "Inter, sans-serif");
  const [logoPreview, setLogoPreview]   = useState<string | null>(localSettings.logoUrl ?? settings?.logoUrl ?? null);
  const [logoFile, setLogoFile]         = useState<File | null>(null);
  const [logoBg, setLogoBg]             = useState<"none" | "black" | "white">(localSettings.logoBg ?? "none");
  const [logoSize, setLogoSize]         = useState<"sm" | "md" | "lg">((settings?.logoSize as "sm" | "md" | "lg") ?? "md");
  const [activePreset, setActivePreset] = useState<string | null>(localSettings.presetName ?? null);
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

  // Store state
  const [products, setProducts]         = useState<StoreProduct[]>(INITIAL_PRODUCTS);
  const [productDrawer, setProductDrawer] = useState(false);
  const [editProduct, setEditProduct]     = useState<StoreProduct | null>(null);
  const [pName, setPName]   = useState("");
  const [pPrice, setPPrice] = useState("");
  const [pCat, setPCat]     = useState<StoreProduct["category"]>("clothing");
  const [pEmoji, setPEmoji] = useState("👕");
  const [pStock, setPStock] = useState(true);

  const { toast } = useToast();
  const isOwner = role === "owner";

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

  const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "overview",  label: "Overview",  icon: LayoutDashboard },
    { id: "branding",  label: "Branding",  icon: Palette },
    { id: "revenue",   label: "Revenue",   icon: DollarSign },
    { id: "store",     label: "Store",     icon: ShoppingBag },
    { id: "staff",     label: "Staff",     icon: Users },
    { id: "account",   label: "Account",   icon: Shield },
  ];

  const inputCls = "w-full bg-transparent border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-white/30 transition-colors";
  const totalMembers = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  // ── Branding save ─────────────────────────────────────────────────────────
  async function saveBranding() {
    setSaving(true);
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
        }
        // if upload fails, keep the base64 preview in localStorage only
      }

      // 2. Persist to localStorage for demo mode (always works)
      const localData = { primaryColor: primaryCol, secondaryColor: secondaryCol, textColor: textCol, bgColor: bgCol, fontFamily, logoUrl: finalLogoUrl, logoBg, logoSize, presetName: activePreset };
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
            logoUrl: typeof finalLogoUrl === "string" && finalLogoUrl.startsWith("/") ? finalLogoUrl : null,
            logoSize,
          }),
        });
      } catch { /* DB not available in demo mode */ }

      setLogoFile(null);
      toast("Branding saved — member app updated", "success");
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
        localStorage.setItem("gym-settings", JSON.stringify({ ...existing, logoUrl: dataUrl, logoBg }));
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

  function saveProduct() {
    if (!pName.trim() || !pPrice) return;
    if (editProduct) {
      setProducts((prev) => prev.map((p) => p.id === editProduct.id ? { ...p, name: pName, price: parseFloat(pPrice), category: pCat, emoji: pEmoji, inStock: pStock } : p));
      toast("Product updated", "success");
    } else {
      const newP: StoreProduct = { id: Date.now().toString(), name: pName, price: parseFloat(pPrice), category: pCat, emoji: pEmoji, inStock: pStock };
      setProducts((prev) => [...prev, newP]);
      toast("Product added", "success");
    }
    setProductDrawer(false);
  }

  function deleteProduct(id: string) {
    if (!confirm("Remove this product?")) return;
    setProducts((prev) => prev.filter((p) => p.id !== id));
    toast("Product removed", "success");
  }

  const maxRevenue = Math.max(...DEMO_REVENUE.history.map((h) => h.revenue));

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-gray-500 text-sm mt-0.5">{settings?.name ?? "Your gym"} · {settings ? TIER_LABELS[settings.subscriptionTier] ?? settings.subscriptionTier : ""} plan</p>
      </div>

      {/* Tabs — scrollable */}
      <div className="overflow-x-auto pb-1 mb-6 scrollbar-hide">
        <div className="flex gap-1 p-1 rounded-xl min-w-max" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className="flex items-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
              style={{ background: tab === id ? "rgba(255,255,255,0.1)" : "transparent", color: tab === id ? "#fff" : "rgba(255,255,255,0.4)" }}
            >
              <Icon className="w-3.5 h-3.5" />{label}
            </button>
          ))}
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
              <div key={label} className="rounded-2xl border p-4 text-center" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
                <p className="text-white text-2xl font-bold">{value}</p>
                <p className="text-gray-500 text-xs mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
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
                <div key={key} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
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

          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Gym Info</h2>
            {[
              { label: "Gym name",     value: settings?.name },
              { label: "Club code",    value: settings?.slug },
              { label: "Plan",         value: settings ? TIER_LABELS[settings.subscriptionTier] : null },
              { label: "Member since", value: settings ? new Date(settings.createdAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : null },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
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
                className="flex items-center justify-between p-4 rounded-2xl border hover:bg-white/5 transition-all"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
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
                background: logoPreview ? hex(primaryCol, 0.04) : "rgba(255,255,255,0.02)",
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
                        className="text-xs px-3 py-1.5 rounded-lg border border-white/10 text-gray-400 hover:text-white transition-colors"
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

          {/* Logo size */}
          <div>
            <label className="text-gray-400 text-xs font-medium block mb-1.5">Logo Size</label>
            <div className="flex gap-2">
              {([
                { value: "sm", label: "S", desc: "Small" },
                { value: "md", label: "M", desc: "Normal" },
                { value: "lg", label: "L", desc: "Large" },
              ] as const).map(({ value, label, desc }) => (
                <button
                  key={value}
                  onClick={() => { if (isOwner) setLogoSize(value); }}
                  disabled={!isOwner}
                  className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl border text-xs font-semibold transition-all disabled:opacity-40"
                  style={{
                    borderColor: logoSize === value ? hex(primaryCol, 0.5) : "rgba(255,255,255,0.1)",
                    background: logoSize === value ? hex(primaryCol, 0.1) : "rgba(255,255,255,0.03)",
                    color: logoSize === value ? primaryCol : "rgba(255,255,255,0.5)",
                  }}
                >
                  <span className="text-sm font-bold">{label}</span>
                  <span className="text-[10px] font-normal">{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Theme presets */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-gray-400 text-xs font-medium">Theme Presets</label>
              <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: "rgba(255,255,255,0.06)" }}>
                {(["dark", "light"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      const first = THEME_PRESETS.find((p) => p.mode === m);
                      if (first) { setPrimaryCol(first.primary); setSecondaryCol(first.secondary); setTextCol(first.text); setBgCol(first.bg); setFontFamily(first.font); setActivePreset(first.name); }
                    }}
                    className="px-3 py-1 rounded-md text-[10px] font-semibold capitalize transition-all"
                    style={{
                      background: THEME_PRESETS.find((p) => p.mode === m && p.name === activePreset) ? "rgba(255,255,255,0.12)" : "transparent",
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
                        borderColor: isActive ? hex(preset.primary, 0.6) : "rgba(255,255,255,0.07)",
                        background: isActive ? hex(preset.primary, 0.08) : "rgba(255,255,255,0.02)",
                      }}
                    >
                      {/* Colour swatch stack */}
                      <div className="relative w-9 h-9 shrink-0">
                        <div className="absolute inset-0 rounded-xl" style={{ background: preset.bg, border: "1px solid rgba(255,255,255,0.1)" }} />
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
                        borderColor: isActive ? hex(preset.primary, 0.6) : "rgba(255,255,255,0.07)",
                        background: isActive ? hex(preset.primary, 0.08) : "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div className="relative w-9 h-9 shrink-0">
                        <div className="absolute inset-0 rounded-xl border border-white/10" style={{ background: preset.bg }} />
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
                      className="w-9 h-9 rounded-lg cursor-pointer border border-white/10 shrink-0" style={{ padding: 2 }} />
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
                    borderColor: fontFamily === font ? hex(primaryCol, 0.5) : "rgba(255,255,255,0.07)",
                    background: fontFamily === font ? hex(primaryCol, 0.08) : "rgba(255,255,255,0.02)",
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
                      background: logoBg === opt ? hex(primaryCol, 0.1) : "rgba(255,255,255,0.03)",
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
                <p className="text-gray-400 text-xs font-medium">Member App Preview</p>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-[10px] font-semibold text-green-400 uppercase tracking-wide">Live</span>
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
                  <PhonePreview gymName={gymName} primaryCol={primaryCol} logoPreview={logoPreview} logoBg={logoBg} bgCol={bgCol} fontFamily={fontFamily} />
                </div>
              </div>
          </div>
        </div>
      )}

      {/* ── Revenue ── */}
      {tab === "revenue" && (
        <div className="space-y-5">
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-blue-400 text-sm">
            Revenue data will connect to Stripe in Phase 2. Figures below are demo data.
          </div>

          {/* MRR cards */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Monthly Revenue",  value: `£${DEMO_REVENUE.mrr.toLocaleString()}`,  sub: "+12% vs last month", color: "#10b981" },
              { label: "Annual Run Rate", value: `£${DEMO_REVENUE.arr.toLocaleString()}`,  sub: "projected",           color: "#3b82f6" },
              { label: "Active Members",  value: DEMO_REVENUE.activeMembers,                sub: "paying members",     color: "#8b5cf6" },
              { label: "Avg per Member",  value: `£${DEMO_REVENUE.avgPerMember}`,           sub: "per month",          color: "#f59e0b" },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="rounded-2xl border p-4" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
                <p className="text-white text-2xl font-bold">{value}</p>
                <p className="text-gray-500 text-xs mt-1">{label}</p>
                <p className="text-xs mt-0.5" style={{ color }}>{sub}</p>
              </div>
            ))}
          </div>

          {/* Revenue chart */}
          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Monthly Revenue</h2>
            <div className="flex items-end gap-2 h-32">
              {DEMO_REVENUE.history.map(({ month, revenue }) => (
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

          {/* Membership tiers */}
          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Membership Tiers</h2>
            <div className="space-y-3">
              {DEMO_REVENUE.memberships.map(({ name, price, count, color }) => (
                <div key={name} className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <span className="text-gray-300 text-sm">{name} · £{price}/mo</span>
                      <span className="text-white text-sm font-semibold">{count} members</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                      <div className="h-full rounded-full" style={{ width: `${(count / DEMO_REVENUE.activeMembers) * 100}%`, background: color }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent membership changes */}
          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Recent Activity</h2>
            <div className="space-y-3">
              {DEMO_REVENUE.recent.map(({ name, action, tier, date }, i) => (
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
                <div key={cat} className="rounded-xl border p-3 text-center" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
                  <p className="text-white font-bold text-lg">{count}</p>
                  <p className="text-gray-500 text-xs">{labels[cat]}</p>
                </div>
              );
            })}
          </div>

          {/* Product list */}
          <div className="space-y-2">
            {products.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3 rounded-2xl border" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)", opacity: p.inStock ? 1 : 0.5 }}>
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
            <div className="rounded-2xl border p-4" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
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
          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
            <h2 className="text-white font-semibold text-sm mb-4">Check-In QR Code</h2>
            <p className="text-gray-500 text-sm mb-3">Share this URL with members or display as a QR code at your gym entrance.</p>
            <div className="flex items-center gap-2 p-3 rounded-xl border border-white/8" style={{ background: "rgba(255,255,255,0.03)" }}>
              <code className="flex-1 text-blue-400 text-sm truncate">
                {typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/checkin/{settings?.slug}
              </code>
              <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/checkin/${settings?.slug}`); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: copied ? hex("#10b981", 0.15) : "rgba(255,255,255,0.07)" }}
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-400" />}
              </button>
              <a href={`/checkin/${settings?.slug}`} target="_blank" rel="noreferrer"
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white transition-colors"
                style={{ background: "rgba(255,255,255,0.07)" }}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
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
                <div key={label} className="p-3 rounded-xl border border-white/8" style={{ background: "rgba(255,255,255,0.03)" }}>
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
                <option value="manager" style={{ background: "#1a1b1e" }}>Manager — all access except billing</option>
                <option value="coach"   style={{ background: "#1a1b1e" }}>Coach — attendance + members</option>
                <option value="admin"   style={{ background: "#1a1b1e" }}>Admin — check-in + front desk</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-1.5">{editStaff ? "New Password (leave blank to keep)" : "Password (leave blank to auto-generate)"}</label>
              <input type="password" className={inputCls} value={sfPassword} onChange={(e) => setSfPassword(e.target.value)} placeholder={editStaff ? "••••••••" : "auto-generated"} />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setStaffDrawer(false)} className="flex-1 py-2.5 rounded-xl border border-white/10 text-gray-400 text-sm font-medium hover:text-white transition-colors">Cancel</button>
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
              <option value="clothing"  style={{ background: "#1a1b1e" }}>Clothing</option>
              <option value="food"      style={{ background: "#1a1b1e" }}>Food</option>
              <option value="drink"     style={{ background: "#1a1b1e" }}>Drinks</option>
              <option value="equipment" style={{ background: "#1a1b1e" }}>Equipment</option>
              <option value="other"     style={{ background: "#1a1b1e" }}>Other</option>
            </select>
          </div>
          <div className="flex items-center justify-between p-3 rounded-xl border border-white/8" style={{ background: "rgba(255,255,255,0.03)" }}>
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
            <button onClick={() => setProductDrawer(false)} className="flex-1 py-2.5 rounded-xl border border-white/10 text-gray-400 text-sm font-medium hover:text-white transition-colors">Cancel</button>
            <button onClick={saveProduct} disabled={!pName.trim() || !pPrice}
              className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
              style={{ background: primaryColor }}
            >
              {editProduct ? "Save" : "Add Product"}
            </button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
