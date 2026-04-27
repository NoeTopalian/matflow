"use client";

import { useEffect, useState } from "react";
import { Package, Loader2, AlertCircle, ShoppingCart, CheckCircle2 } from "lucide-react";

type OwnedPack = {
  id: string;
  packId: string;
  name: string;
  creditsRemaining: number;
  totalCredits: number;
  purchasedAt: string;
  expiresAt: string;
};

type AvailablePack = {
  id: string;
  name: string;
  description: string | null;
  totalCredits: number;
  validityDays: number;
  pricePence: number;
  currency: string;
};

function formatPrice(pence: number, currency: string) {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

function daysLeft(iso: string) {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export default function ClassPacksWidget({ primaryColor = "#3b82f6" }: { primaryColor?: string }) {
  const [owned, setOwned] = useState<OwnedPack[]>([]);
  const [available, setAvailable] = useState<AvailablePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/member/class-packs");
      const data = await res.json();
      setOwned(Array.isArray(data?.owned) ? data.owned : []);
      setAvailable(Array.isArray(data?.available) ? data.available : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function buy(packId: string) {
    setBuying(packId);
    setError(null);
    try {
      const res = await fetch("/api/member/class-packs/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Couldn't start checkout");
        setBuying(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network error");
      setBuying(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl p-5 border" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
        <div className="flex items-center gap-2" style={{ color: "rgba(255,255,255,0.5)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading class packs…</span>
        </div>
      </div>
    );
  }

  if (available.length === 0 && owned.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {owned.length > 0 && (
        <div className="rounded-2xl p-5 border" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
          <p className="font-semibold text-sm text-white mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Your active packs
          </p>
          <ul className="space-y-2">
            {owned.map((p) => {
              const pct = Math.round((p.creditsRemaining / p.totalCredits) * 100);
              return (
                <li key={p.id} className="rounded-xl p-3 border" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <p className="text-sm font-medium text-white">{p.name}</p>
                    <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.5)" }}>
                      {daysLeft(p.expiresAt)}d left
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.max(3, pct)}%`, background: primaryColor }} />
                    </div>
                    <span className="text-xs tabular-nums shrink-0" style={{ color: "rgba(255,255,255,0.7)" }}>
                      {p.creditsRemaining} / {p.totalCredits}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {available.length > 0 && (
        <div className="rounded-2xl p-5 border" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
          <p className="font-semibold text-sm text-white mb-1 flex items-center gap-2">
            <Package className="w-4 h-4" />
            Buy a class pack
          </p>
          <p className="text-xs mb-3" style={{ color: "rgba(255,255,255,0.5)" }}>
            One-off purchase. Credits decrement when you check in to a class.
          </p>
          {error && (
            <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border text-xs" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          <ul className="space-y-2">
            {available.map((p) => (
              <li key={p.id} className="rounded-xl p-3 border flex items-center justify-between gap-3" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{p.name}</p>
                  <p className="text-[11px] mt-0.5" style={{ color: "rgba(255,255,255,0.5)" }}>
                    {p.totalCredits} classes · valid {p.validityDays} days
                  </p>
                  {p.description && <p className="text-[11px] mt-1" style={{ color: "rgba(255,255,255,0.55)" }}>{p.description}</p>}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <p className="text-sm font-bold text-white tabular-nums">{formatPrice(p.pricePence, p.currency)}</p>
                  <button
                    onClick={() => buy(p.id)}
                    disabled={buying !== null}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50"
                    style={{ background: primaryColor }}
                  >
                    {buying === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShoppingCart className="w-3.5 h-3.5" />}
                    Buy
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
