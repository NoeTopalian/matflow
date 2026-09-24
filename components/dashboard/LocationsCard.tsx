"use client";

/**
 * Settings → Overview → Locations (ADR-001 D2, slice 1).
 *
 * A club with one venue sees one row and can ignore this. A club with more
 * adds them here; classes then pick a venue in the class form. The default
 * cannot be removed and a venue with classes on it cannot be removed — the
 * API refuses and this card shows the reason, never an empty success.
 * UI-RULES §7: a failed read renders an error, not "no locations".
 */
import { useCallback, useEffect, useState } from "react";
import { MapPin, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";

export type LocationRow = { id: string; name: string; address: string | null; isDefault: boolean };

export default function LocationsCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<LocationRow[] | null>(null);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<LocationRow | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/locations");
      if (!res.ok) { setError(true); return; }
      const data = (await res.json()) as { locations: LocationRow[] };
      setRows(data.locations);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    setSaving(true);
    try {
      const res = await fetch("/api/locations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, address: address || null }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast(data.error ?? "Could not add the location", "error"); return; }
      setRows((prev) => [...(prev ?? []), data]);
      setName(""); setAddress(""); setAdding(false);
      toast("Location added", "success");
    } catch {
      toast("Could not add the location", "error");
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(row: LocationRow) {
    const res = await fetch(`/api/locations/${row.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isDefault: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error ?? "Could not change the default", "error"); return; }
    setRows((prev) => (prev ?? []).map((r) => ({ ...r, isDefault: r.id === row.id })));
    toast(`${row.name} is now the default location`, "success");
  }

  async function remove() {
    if (!removing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/locations/${removing.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast(data.error ?? "Could not remove the location", "error"); return; }
      setRows((prev) => (prev ?? []).filter((r) => r.id !== removing.id));
      setRemoving(null);
      toast("Location removed", "success");
    } catch {
      toast("Could not remove the location", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }} data-testid="locations-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Locations</h2>
          <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
            Where your classes run. One venue needs nothing here; add more and each class can name its venue.
          </p>
        </div>
        {canEdit && !adding && (
          <Button variant="secondary" size="compact" onClick={() => setAdding(true)}>
            <Plus className="w-3.5 h-3.5" /> Add location
          </Button>
        )}
      </div>

      {error ? (
        <div className="mt-4" role="alert"><ErrorState message="Could not load locations — tap to retry" onRetry={load} /></div>
      ) : rows === null ? (
        <p className="mt-4 text-xs" style={{ color: "var(--tx-3)" }} aria-busy>Loading locations…</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-xl border px-3 py-2" style={{ borderColor: "var(--bd-default)" }} data-testid="location-row">
              <MapPin className="w-4 h-4 shrink-0" style={{ color: "var(--tx-4)" }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>
                  {r.name}
                  {r.isDefault && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--tx-3)" }}>Default</span>}
                </p>
                {r.address && <p className="text-xs truncate" style={{ color: "var(--tx-3)" }}>{r.address}</p>}
              </div>
              {canEdit && !r.isDefault && (
                <>
                  <Button variant="ghost" size="compact" onClick={() => makeDefault(r)} aria-label={`Make ${r.name} the default location`} title="Make default">
                    <Star className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="compact" onClick={() => setRemoving(r)} aria-label={`Remove ${r.name}`} title="Remove">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
          onSubmit={(e) => { e.preventDefault(); void add(); }}
        >
          <label className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>
            Name
            <input aria-label="Location name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }} placeholder="Northside" />
          </label>
          <label className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>
            Address (optional)
            <input aria-label="Location address" maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }} placeholder="12 High Street" />
          </label>
          <Button type="submit" disabled={saving || !name.trim()}>{saving ? "Adding…" : "Add"}</Button>
          <Button type="button" variant="ghost" onClick={() => { setAdding(false); setName(""); setAddress(""); }}>Cancel</Button>
        </form>
      )}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => { if (!saving) setRemoving(null); }}
        title={removing ? `Remove ${removing.name}?` : "Remove location"}
        description="Classes at this venue block removal — move them first. The default location cannot be removed."
        confirmLabel={saving ? "Removing…" : "Remove location"}
        destructive
        loading={saving}
        onConfirm={remove}
      />
    </div>
  );
}
