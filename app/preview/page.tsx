"use client";

import { useState } from "react";
import {
  LayoutDashboard, Users, Calendar, Award, ClipboardList,
  Bell, BarChart2, Settings, QrCode, LogOut, Plus,
  CalendarCheck, TrendingUp, AlertTriangle, Megaphone,
  ChevronRight,
} from "lucide-react";

const PRESETS = [
  { name: "Total BJJ", primary: "#3b82f6", secondary: "#2563eb", text: "#ffffff" },
  { name: "Red Dragon MMA", primary: "#ef4444", secondary: "#dc2626", text: "#ffffff" },
  { name: "Gold Standard", primary: "#f59e0b", secondary: "#d97706", text: "#ffffff" },
  { name: "Emerald Judo", primary: "#10b981", secondary: "#059669", text: "#ffffff" },
  { name: "Navy Combat", primary: "#6366f1", secondary: "#4f46e5", text: "#ffffff" },
];

const NAV = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Members", icon: Users },
  { label: "Timetable", icon: Calendar },
  { label: "Attendance", icon: ClipboardList },
  { label: "Check-In", icon: QrCode },
  { label: "Ranks", icon: Award },
  { label: "Notifications", icon: Bell },
  { label: "Reports", icon: BarChart2 },
  { label: "Settings", icon: Settings },
];

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function PreviewPage() {
  const [sel, setSel] = useState(0);
  const [activeNav, setActiveNav] = useState("Dashboard");
  const [primary, setPrimary] = useState(PRESETS[0].primary);
  const [secondary, setSecondary] = useState(PRESETS[0].secondary);
  const [textColor, setTextColor] = useState(PRESETS[0].text);
  const [gymName, setGymName] = useState(PRESETS[0].name);

  function applyPreset(i: number) {
    setSel(i);
    setPrimary(PRESETS[i].primary);
    setSecondary(PRESETS[i].secondary);
    setTextColor(PRESETS[i].text);
    setGymName(PRESETS[i].name);
  }

  const cards = [
    { label: "Members", value: "47", sub: "42 active", icon: Users },
    { label: "Classes Today", value: "4", sub: "2 remaining", icon: CalendarCheck },
    { label: "Check-ins", value: "23", sub: "today", icon: TrendingUp },
    { label: "At-Risk", value: "3", sub: "AI prediction", icon: AlertTriangle },
  ];

  const classes = [
    { name: "Beginner BJJ", time: "10:00", coach: "Coach Mike", spots: "12/20" },
    { name: "Open Mat", time: "12:00", coach: "Coach Sarah", spots: "8/∞" },
    { name: "No-Gi", time: "18:00", coach: "Coach Mike", spots: "15/20" },
    { name: "Kids BJJ", time: "17:00", coach: "Coach Emma", spots: "6/12" },
  ];

  const activity = [
    { name: "James K.", action: "checked in", detail: "No-Gi", time: "2m" },
    { name: "Sarah M.", action: "promoted", detail: "Blue Belt", time: "1h" },
    { name: "Tom R.", action: "checked in", detail: "Open Mat", time: "2h" },
    { name: "Alex P.", action: "joined", detail: "Beginner BJJ", time: "3h" },
  ];

  return (
    <div style={{ background: "#07080a", minHeight: "100vh", padding: "24px", fontFamily: "system-ui, sans-serif" }}>

      {/* Controls */}
      <div style={{ maxWidth: 1100, margin: "0 auto 20px", background: "#0e1013", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "16px 20px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20 }}>
        <div>
          <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Theme presets</p>
          <div style={{ display: "flex", gap: 6 }}>
            {PRESETS.map((p, i) => (
              <button key={p.name} onClick={() => applyPreset(i)} style={{
                padding: "5px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, border: "none", cursor: "pointer", transition: "all 0.15s",
                background: sel === i ? p.primary : "rgba(255,255,255,0.05)",
                color: sel === i ? "white" : "rgba(255,255,255,0.4)",
              }}>{p.name}</button>
            ))}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 20 }}>
          {[
            { label: "Primary", value: primary, onChange: setPrimary },
            { label: "Secondary", value: secondary, onChange: setSecondary },
            { label: "Text", value: textColor, onChange: setTextColor },
          ].map(({ label, value, onChange }) => (
            <div key={label}>
              <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{label}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="color" value={value} onChange={e => onChange(e.target.value)}
                  style={{ width: 28, height: 28, borderRadius: 6, border: "none", cursor: "pointer", background: "transparent" }} />
                <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, fontFamily: "monospace" }}>{value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* App Shell */}
      <div style={{ maxWidth: 1100, margin: "0 auto", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", display: "flex", height: 640 }}>

        {/* Sidebar */}
        <div style={{ width: 220, background: "#0a0b0e", borderRight: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          {/* Gym header */}
          <div style={{ padding: "20px 16px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: primary, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                {gymName.charAt(0)}
              </div>
              <div>
                <p style={{ color: "white", fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>{gymName}</p>
                <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, marginTop: 2 }}>MatFlow</p>
              </div>
            </div>
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, padding: "10px 8px", overflowY: "auto" }}>
            {NAV.map((item) => {
              const active = item.label === activeNav;
              return (
                <button key={item.label} onClick={() => setActiveNav(item.label)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", marginBottom: 1, textAlign: "left", transition: "all 0.12s",
                    background: active ? hex(primary, 0.1) : "transparent",
                    color: active ? primary : "rgba(255,255,255,0.35)",
                    fontSize: 13, fontWeight: active ? 600 : 400,
                    borderLeft: active ? `2px solid ${primary}` : "2px solid transparent",
                  }}>
                  <item.icon style={{ width: 15, height: 15, flexShrink: 0 }} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <p style={{ color: "rgba(255,255,255,0.15)", fontSize: 10 }}>v1.0 MVP</p>
          </div>
        </div>

        {/* Main */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#07080a", minWidth: 0 }}>

          {/* Topbar */}
          <div style={{ height: 52, background: "#0a0b0e", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 20px", gap: 12, flexShrink: 0 }}>
            <div style={{ textAlign: "right" }}>
              <p style={{ color: "white", fontSize: 12, fontWeight: 500, lineHeight: 1.2 }}>Noe Martinez</p>
              <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, marginTop: 1 }}>Owner</p>
            </div>
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: primary, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 11, fontWeight: 700 }}>NM</div>
            <LogOut style={{ width: 14, height: 14, color: "rgba(255,255,255,0.2)", cursor: "pointer" }} />
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px" }}>

            {/* Header row */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
              <div>
                <h1 style={{ color: "white", fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.3px" }}>Good evening, Noe</h1>
                <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, margin: "4px 0 0" }}>{gymName} · Saturday, 7 March</p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {[{ icon: QrCode, label: "Check-In" }, { icon: Megaphone, label: "Announce" }].map(({ icon: Icon, label }) => (
                  <button key={label} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)", fontSize: 12, cursor: "pointer" }}>
                    <Icon style={{ width: 13, height: 13 }} />{label}
                  </button>
                ))}
                <button style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: primary, border: "none", color: "white", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  <Plus style={{ width: 13, height: 13 }} />New Member
                </button>
              </div>
            </div>

            {/* Stat cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
              {cards.map((card) => (
                <div key={card.label} style={{ background: "#0e1013", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px" }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: hex(primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                    <card.icon style={{ width: 14, height: 14, color: primary }} />
                  </div>
                  <p style={{ color: "white", fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.5px" }}>{card.value}</p>
                  <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, margin: "4px 0 0", fontWeight: 500 }}>{card.label}</p>
                  <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, margin: "2px 0 0" }}>{card.sub}</p>
                </div>
              ))}
            </div>

            {/* Bottom panels */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* Classes */}
              <div style={{ background: "#0e1013", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <p style={{ color: "white", fontSize: 13, fontWeight: 600, margin: 0 }}>Today&apos;s Classes</p>
                  <span style={{ color: primary, fontSize: 11, cursor: "pointer" }}>View all →</span>
                </div>
                {classes.map((cls) => (
                  <div key={cls.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: primary, flexShrink: 0 }} />
                      <div>
                        <p style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, margin: 0 }}>{cls.name}</p>
                        <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, margin: "1px 0 0" }}>{cls.coach}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, margin: 0 }}>{cls.time}</p>
                      <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, margin: "1px 0 0" }}>{cls.spots}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Activity */}
              <div style={{ background: "#0e1013", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px" }}>
                <p style={{ color: "white", fontSize: 13, fontWeight: 600, margin: "0 0 14px" }}>Recent Activity</p>
                {activity.map((a) => (
                  <div key={a.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 28, height: 28, borderRadius: "50%", background: hex(primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", color: primary, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                        {a.name[0]}
                      </div>
                      <div>
                        <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, margin: 0 }}>
                          <span style={{ fontWeight: 500 }}>{a.name}</span>
                          <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400 }}> {a.action} </span>
                          <span style={{ color: primary }}>{a.detail}</span>
                        </p>
                      </div>
                    </div>
                    <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>{a.time} ago</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>

      <p style={{ textAlign: "center", color: "rgba(255,255,255,0.12)", fontSize: 11, marginTop: 16 }}>
        Preview only — colours are fully customisable per gym in Settings
      </p>
    </div>
  );
}
