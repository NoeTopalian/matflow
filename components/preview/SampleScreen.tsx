"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Calendar, Users, MapPin, Clock } from "lucide-react";

const LIST_ITEMS = [
  { id: "1", title: "Beginner BJJ", time: "10:00 – 11:00", coach: "Coach Mike",  spots: "8/20"  },
  { id: "2", title: "Open Mat",      time: "12:00 – 14:00", coach: "Coach Sarah", spots: "—"     },
  { id: "3", title: "No-Gi",         time: "18:00 – 19:00", coach: "Coach Mike",  spots: "5/20"  },
  { id: "4", title: "Kids BJJ",      time: "17:00 – 17:45", coach: "Coach Emma",  spots: "6/12"  },
  { id: "5", title: "Wrestling",     time: "19:30 – 20:30", coach: "Coach Mike",  spots: "Full"  },
  { id: "6", title: "Open Roll",     time: "21:00 – 22:00", coach: "Drop-in",     spots: "—"     },
];

export default function SampleScreen({
  screen,
  toScreen,
  toScreenLabel,
}: {
  screen: "list" | "detail";
  toScreen: string;
  toScreenLabel: string;
}) {
  if (screen === "list") {
    return (
      <div className="max-w-2xl mx-auto px-5 py-6 space-y-4">
        <div className="rounded-2xl p-5" style={{ background: "var(--color-primary-dim)", border: "1px solid var(--color-primary)" }}>
          <p className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: "var(--color-primary)" }}>Today</p>
          <h1 className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>Today&apos;s Classes</h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>{LIST_ITEMS.length} sessions running</p>
        </div>
        <div className="space-y-2">
          {LIST_ITEMS.map((item) => (
            <Link
              key={item.id}
              href={toScreen}
              className="block rounded-2xl border p-4 transition-all active:scale-[0.99] hover:brightness-110"
              style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
            >
              <div className="flex items-center gap-3">
                <div className="w-1 self-stretch rounded-full" style={{ background: "var(--color-primary)" }} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>{item.title}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: "var(--tx-3)" }}>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{item.time}</span>
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" />{item.coach}</span>
                  </div>
                </div>
                <span className="text-xs font-semibold shrink-0" style={{ color: "var(--tx-3)" }}>{item.spots}</span>
                <ArrowRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-4)" }} />
              </div>
            </Link>
          ))}
        </div>
        <div className="pt-2 text-center">
          <Link href={toScreen} className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl font-semibold text-white text-sm" style={{ background: "var(--color-primary)" }}>
            {toScreenLabel} <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-5 py-6 space-y-4">
      <Link href={toScreen} className="inline-flex items-center gap-2 text-sm" style={{ color: "var(--tx-3)" }}>
        <ArrowLeft className="w-4 h-4" /> Back
      </Link>
      <div className="rounded-3xl p-6" style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)" }}>
        <p className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: "var(--color-primary)" }}>Class detail</p>
        <h1 className="text-3xl font-bold mb-2" style={{ color: "var(--tx-1)" }}>Beginner BJJ</h1>
        <p className="text-sm mb-5" style={{ color: "var(--tx-3)" }}>Foundational gi class — drilling, positional sparring, light rolling.</p>
        <div className="grid grid-cols-2 gap-3">
          <Stat icon={Clock}    label="Time"     value="10:00 – 11:00" />
          <Stat icon={Users}    label="Coach"    value="Mike"          />
          <Stat icon={MapPin}   label="Location" value="Mat 1"          />
          <Stat icon={Calendar} label="Capacity" value="8 / 20"         />
        </div>
        <div className="mt-6 flex gap-2">
          <button className="flex-1 py-3 rounded-2xl font-semibold text-white text-sm" style={{ background: "var(--color-primary)" }}>
            Check me in
          </button>
          <button className="px-4 py-3 rounded-2xl font-semibold text-sm" style={{ background: "var(--sf-2)", color: "var(--tx-1)" }}>
            Save
          </button>
        </div>
      </div>
      <div className="pt-2 text-center">
        <Link href={toScreen} className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl font-semibold text-sm" style={{ background: "var(--sf-2)", color: "var(--tx-1)" }}>
          <ArrowLeft className="w-4 h-4" /> {toScreenLabel}
        </Link>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; label: string; value: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--sf-2)" }}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: "var(--tx-4)" }}>
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{value}</p>
    </div>
  );
}
