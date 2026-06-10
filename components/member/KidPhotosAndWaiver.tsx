"use client";

import { useState, useRef } from "react";
import { Camera, Trash2, FileCheck2, AlertTriangle, Loader2, X } from "lucide-react";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { buildDefaultKidsWaiverTitle, buildDefaultKidsWaiverContent } from "@/lib/default-waiver";

/**
 * US-5: photo grid + parent-waiver-sign block embedded inside
 * /member/family/[childId]. The server page hydrates the initial photo
 * list + waiver state; this component handles the client-side upload /
 * delete / sign flow.
 */

export type PhotoRow = {
  id: string;
  url: string;
  caption: string | null;
  kind: string;
  uploadedAt: string; // ISO
};

interface Props {
  childId: string;
  childName: string;
  waiverAccepted: boolean;
  initialPhotos: PhotoRow[];
  kidsWaiverTitle?: string | null;
  kidsWaiverContent?: string | null;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const PRIMARY = "#3b82f6";

export default function KidPhotosAndWaiver({ childId, childName, waiverAccepted, initialPhotos, kidsWaiverTitle, kidsWaiverContent }: Props) {
  const [photos, setPhotos] = useState<PhotoRow[]>(initialPhotos);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [waiverSigned, setWaiverSigned] = useState(waiverAccepted);
  const [showSign, setShowSign] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      // First upload to the shared /api/upload route (Vercel Blob with
      // data: URL fallback) so we get a stable URL the schema can store.
      const form = new FormData();
      form.append("file", file);
      const upRes = await fetch("/api/upload", { method: "POST", body: form });
      let url: string;
      if (upRes.ok) {
        const upData = (await upRes.json()) as { url: string };
        url = upData.url;
      } else {
        // Fallback: encode the file as a data: URL and let the photo
        // route store it directly. Capped at ~3MB on the server side.
        url = await readAsDataUrl(file);
      }

      const photoRes = await fetch(`/api/member/children/${childId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, kind: "evidence" }),
      });
      if (!photoRes.ok) {
        const data = await photoRes.json().catch(() => ({}));
        setUploadError((data as { error?: string }).error ?? "Couldn't save photo. Try again.");
        return;
      }
      const created = (await photoRes.json()) as PhotoRow;
      setPhotos((prev) => [created, ...prev]);
    } catch {
      setUploadError("Network error. Try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(photoId: string) {
    if (!confirm("Remove this photo?")) return;
    const res = await fetch(`/api/member/children/${childId}/photos/${photoId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    }
  }

  return (
    <>
      {/* ── Waiver sign CTA (only when missing) ───────────────────────────── */}
      {!waiverSigned && (
        <div
          className="rounded-2xl border p-4 mb-5"
          style={{ borderColor: "rgba(245,158,11,0.25)", background: "rgba(245,158,11,0.06)" }}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-amber-300 text-sm font-semibold">Waiver missing for {childName}</p>
              <p className="text-amber-200/70 text-xs mt-0.5">
                Sign the gym&apos;s liability waiver as their guardian before they next attend.
              </p>
              <button
                onClick={() => setShowSign(true)}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: "rgba(245,158,11,0.18)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.35)" }}
              >
                <FileCheck2 className="w-3.5 h-3.5" /> Sign waiver
              </button>
            </div>
          </div>
        </div>
      )}
      {waiverSigned && (
        <div
          className="rounded-2xl border p-3 mb-5 flex items-center gap-2"
          style={{ borderColor: "rgba(34,197,94,0.25)", background: "rgba(34,197,94,0.06)" }}
        >
          <FileCheck2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <p className="text-emerald-300 text-xs font-medium">Waiver signed for {childName}</p>
        </div>
      )}

      {/* ── Photo grid ────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border overflow-hidden mb-5" style={{ borderColor: "var(--member-border)" }}>
        <div className="px-4 pt-4 pb-3 flex items-center justify-between">
          <div>
            <p className="text-white text-sm font-semibold">Photos</p>
            <p className="text-gray-500 text-xs mt-0.5">Belt promotions, training evidence — only you and the gym see these.</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
            style={{ background: hex(PRIMARY, 0.15), color: PRIMARY, border: `1px solid ${hex(PRIMARY, 0.3)}` }}
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
            {uploading ? "Uploading…" : "Add photo"}
          </button>
        </div>
        {uploadError && (
          <p className="px-4 pb-3 text-red-400 text-xs">{uploadError}</p>
        )}
        {photos.length === 0 ? (
          <p className="px-4 pb-4 text-gray-500 text-sm">No photos yet — tap &quot;Add photo&quot; to upload one.</p>
        ) : (
          <div className="grid grid-cols-3 gap-1 p-1">
            {photos.map((p) => (
              <div key={p.id} className="relative group aspect-square overflow-hidden rounded-md" style={{ background: "var(--member-surface)" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={toBlobProxyUrl(p.url) ?? p.url} alt={p.caption ?? "Photo"} className="w-full h-full object-cover" />
                <button
                  onClick={() => handleDelete(p.id)}
                  aria-label="Remove photo"
                  className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showSign && (
        <SignWaiverModal
          childId={childId}
          childName={childName}
          waiverTitle={kidsWaiverTitle ?? undefined}
          waiverContent={kidsWaiverContent ?? undefined}
          onClose={() => setShowSign(false)}
          onSigned={() => {
            setWaiverSigned(true);
            setShowSign(false);
          }}
        />
      )}
    </>
  );
}

// ─── Inline sign waiver modal ──────────────────────────────────────────────

function SignWaiverModal({
  childId,
  childName,
  waiverTitle,
  waiverContent,
  onClose,
  onSigned,
}: {
  childId: string;
  childName: string;
  waiverTitle?: string;
  waiverContent?: string;
  onClose: () => void;
  onSigned: () => void;
}) {
  const [signerName, setSignerName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const padRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasMark, setHasMark] = useState(false);

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = padRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    setIsDrawing(true);
    const r = c.getBoundingClientRect();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(e.clientX - r.left, e.clientY - r.top);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!isDrawing) return;
    const c = padRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const r = c.getBoundingClientRect();
    ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
    ctx.stroke();
    setHasMark(true);
  }
  function end() { setIsDrawing(false); }
  function clearPad() {
    const c = padRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    setHasMark(false);
  }

  const canSubmit = signerName.trim().length > 0 && agreed && hasMark && !signing;

  async function submit() {
    if (!canSubmit) return;
    setSigning(true);
    setError(null);
    try {
      const c = padRef.current;
      if (!c) throw new Error("no canvas");
      const dataUrl = c.toDataURL("image/png");
      const res = await fetch("/api/waiver/sign-for-child", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          childMemberId: childId,
          signatureDataUrl: dataUrl,
          signerName: signerName.trim(),
          agreedTo: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? "Couldn't save the waiver. Try again.");
        setSigning(false);
        return;
      }
      onSigned();
    } catch {
      setError("Network error. Try again.");
      setSigning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center" onClick={onClose} aria-modal="true" role="dialog">
      <div className="bg-[var(--member-elevated)] border border-[var(--member-elevated-border)] rounded-t-3xl md:rounded-3xl w-full md:max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-bold text-base">Sign waiver — {childName}</h2>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--member-surface)" }}>
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <div
          className="rounded-xl border p-3 mb-3 h-36 overflow-y-auto text-xs leading-relaxed space-y-2"
          style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "#94a3b8" }}
        >
          <p className="font-semibold text-sm text-white">
            {waiverTitle ?? buildDefaultKidsWaiverTitle()}
          </p>
          {(waiverContent ?? buildDefaultKidsWaiverContent())
            .split("\n\n").map((para, i) => <p key={i}>{para}</p>)}
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-gray-500 text-xs uppercase tracking-wider block mb-1">Your name</label>
            <input
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="Parent or guardian name"
              className="w-full rounded-lg px-3 py-2.5 text-white text-sm outline-none border placeholder-gray-600"
              style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
            />
          </div>
          <label className="flex items-start gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
            <span>I agree to the gym&apos;s liability waiver on behalf of {childName}.</span>
          </label>
          <div>
            <label className="text-gray-500 text-xs uppercase tracking-wider block mb-1">Signature</label>
            <div className="rounded-lg border" style={{ borderColor: "var(--member-border)", background: "var(--member-surface)" }}>
              <canvas
                ref={padRef}
                width={400}
                height={140}
                className="w-full touch-none rounded-lg"
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerLeave={end}
              />
            </div>
            <button onClick={clearPad} className="text-xs text-gray-500 mt-1">Clear signature</button>
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full mt-4 py-3 rounded-2xl text-white font-semibold text-sm transition-all disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ background: PRIMARY, boxShadow: `0 6px 18px ${hex(PRIMARY, 0.3)}` }}
        >
          {signing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sign waiver"}
        </button>
      </div>
    </div>
  );
}
