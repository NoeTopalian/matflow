"use client";

import { useState, useRef } from "react";
import { Bell, Plus, Trash2, X, Megaphone, Clock, UploadCloud, Pin, Image as ImageIcon, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import NextImage from "next/image";

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  pinned?: boolean;
  createdAt: string;
}

interface Props {
  announcements: AnnouncementRow[];
  primaryColor: string;
  role: string;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function AnnouncementsView({ announcements: initial, primaryColor, role }: Props) {
  const { toast } = useToast();
  const [announcements, setAnnouncements] = useState(initial);
  const [showDrawer, setShowDrawer] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", pinned: false });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const canManage = ["owner", "manager"].includes(role);

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast("Image must be under 5MB", "error"); return; }
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  function resetDrawer() {
    setForm({ title: "", body: "", pinned: false });
    setImageFile(null);
    setImagePreview(null);
    setShowDrawer(false);
  }

  async function create() {
    if (!form.title.trim() || !form.body.trim()) {
      toast("Title and message are required", "error");
      return;
    }
    setSaving(true);
    try {
      // Upload image first if one was selected
      let finalImageUrl: string | null = null;
      if (imageFile) {
        setUploadingImage(true);
        const fd = new FormData();
        fd.append("file", imageFile);
        // Reuse the existing upload endpoint, rename announcement-specific uploads
        fd.append("prefix", "announcement");
        const upRes = await fetch("/api/upload", { method: "POST", body: fd });
        if (upRes.ok) {
          const { url } = await upRes.json();
          finalImageUrl = url;
        } else {
          // If upload fails, use base64 preview as fallback
          finalImageUrl = imagePreview;
        }
        setUploadingImage(false);
      }

      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:    form.title.trim(),
          body:     form.body.trim(),
          imageUrl: finalImageUrl,
          pinned:   form.pinned,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast(err.error ?? "Failed to post", "error");
        return;
      }
      const created: AnnouncementRow = await res.json();
      // Pinned announcements go to top
      setAnnouncements((prev) =>
        created.pinned ? [created, ...prev] : [...prev, created]
      );
      resetDrawer();
      toast("Announcement posted", "success");
    } finally {
      setSaving(false);
      setUploadingImage(false);
    }
  }

  async function remove(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/announcements/${id}`, { method: "DELETE" });
      if (!res.ok) { toast("Failed to delete", "error"); return; }
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
      toast("Deleted", "success");
    } finally {
      setDeleting(null);
    }
  }

  const inputCls = "w-full bg-transparent border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-white/30 placeholder:text-gray-600 transition-colors";

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Announcements</h1>
          <p className="text-gray-500 text-sm mt-0.5">Post updates to your gym community</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowDrawer(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: primaryColor }}
          >
            <Plus className="w-4 h-4" />
            New Post
          </button>
        )}
      </div>

      {/* Feed */}
      {announcements.length === 0 ? (
        <div className="rounded-2xl border p-16 text-center" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: hex(primaryColor, 0.1) }}>
            <Megaphone className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <p className="text-white font-semibold">No announcements yet</p>
          <p className="text-gray-500 text-sm mt-1">
            {canManage ? "Post your first announcement to keep members informed." : "Check back later for updates from your gym."}
          </p>
          {canManage && (
            <button onClick={() => setShowDrawer(true)} className="mt-4 px-5 py-2.5 rounded-xl text-sm font-medium text-white" style={{ background: primaryColor }}>
              Post Announcement
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {announcements.map((a) => (
            <div
              key={a.id}
              className="rounded-2xl border overflow-hidden group"
              style={{
                background: a.pinned ? hex(primaryColor, 0.04) : "rgba(255,255,255,0.02)",
                borderColor: a.pinned ? hex(primaryColor, 0.2) : "rgba(255,255,255,0.06)",
              }}
            >
              {/* Announcement image */}
              {a.imageUrl && (
                <div className="relative w-full" style={{ height: 200 }}>
                  {a.imageUrl.startsWith("data:") || a.imageUrl.startsWith("/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.imageUrl} alt={a.title} className="w-full h-full object-cover" />
                  ) : (
                    <NextImage src={a.imageUrl} alt={a.title} fill className="object-cover" unoptimized />
                  )}
                  <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 40%, rgba(7,8,10,0.7) 100%)" }} />
                </div>
              )}

              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5" style={{ background: hex(primaryColor, 0.12) }}>
                      {a.pinned ? <Pin className="w-4 h-4" style={{ color: primaryColor }} /> : <Bell className="w-4 h-4" style={{ color: primaryColor }} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {a.pinned && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: hex(primaryColor, 0.15), color: primaryColor }}>
                            PINNED
                          </span>
                        )}
                        <h3 className="text-white font-semibold text-sm leading-tight">{a.title}</h3>
                      </div>
                      <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-wrap">{a.body}</p>
                      <div className="flex items-center gap-1 mt-3">
                        <Clock className="w-3 h-3 text-gray-600" />
                        <span className="text-gray-600 text-xs">{timeAgo(a.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => remove(a.id)}
                      disabled={deleting === a.id}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-500/10 text-gray-600 hover:text-red-400 transition-all shrink-0 disabled:opacity-50"
                      title="Delete announcement"
                    >
                      {deleting === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create drawer */}
      {showDrawer && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetDrawer} />
          <div
            className="relative w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl border flex flex-col overflow-hidden"
            style={{ background: "#0e1016", borderColor: "rgba(255,255,255,0.1)", maxHeight: "90vh" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
              <h3 className="text-white font-semibold">New Announcement</h3>
              <button onClick={resetDrawer} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white" style={{ background: "rgba(255,255,255,0.07)" }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Title */}
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block font-medium">Title *</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Gym closed this Saturday"
                  maxLength={120}
                  className={inputCls}
                />
              </div>

              {/* Message */}
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block font-medium">Message *</label>
                <textarea
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  placeholder="Write your announcement here…"
                  rows={5}
                  maxLength={2000}
                  className={inputCls + " resize-none"}
                />
                <p className="text-gray-600 text-xs mt-1 text-right">{form.body.length}/2000</p>
              </div>

              {/* Image upload */}
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block font-medium">Image (optional)</label>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageChange} />

                {imagePreview ? (
                  <div className="relative rounded-2xl overflow-hidden" style={{ height: 160 }}>
                    <img src={imagePreview} alt="Preview" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center gap-3 opacity-0 hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => imageInputRef.current?.click()}
                        className="px-3 py-1.5 rounded-lg bg-white/20 text-white text-xs font-medium backdrop-blur-sm"
                      >
                        Replace
                      </button>
                      <button
                        onClick={() => { setImageFile(null); setImagePreview(null); }}
                        className="px-3 py-1.5 rounded-lg bg-red-500/40 text-white text-xs font-medium backdrop-blur-sm"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => imageInputRef.current?.click()}
                    className="w-full flex flex-col items-center gap-2 py-8 rounded-2xl border-2 border-dashed transition-all hover:border-white/20"
                    style={{ borderColor: "rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.02)" }}
                  >
                    <ImageIcon className="w-7 h-7 text-gray-600" />
                    <div className="text-center">
                      <p className="text-gray-400 text-sm font-medium">Add an image</p>
                      <p className="text-gray-600 text-xs mt-0.5">PNG, JPG, WebP · Max 5MB</p>
                    </div>
                    <div className="flex items-center gap-1.5 text-gray-600 text-xs mt-1">
                      <UploadCloud className="w-3.5 h-3.5" />
                      Click to upload
                    </div>
                  </button>
                )}
              </div>

              {/* Pinned toggle */}
              <div
                className="flex items-center justify-between p-3 rounded-xl border border-white/8"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <div>
                  <p className="text-white text-sm font-medium">Pin to top</p>
                  <p className="text-gray-600 text-xs mt-0.5">Pinned posts always appear first for members</p>
                </div>
                <button
                  onClick={() => setForm((f) => ({ ...f, pinned: !f.pinned }))}
                  className="w-11 h-6 rounded-full transition-all relative shrink-0"
                  style={{ background: form.pinned ? primaryColor : "rgba(255,255,255,0.1)" }}
                >
                  <div className="w-4 h-4 bg-white rounded-full absolute top-1 transition-all" style={{ left: form.pinned ? "calc(100% - 20px)" : 4 }} />
                </button>
              </div>
            </div>

            {/* Footer buttons */}
            <div className="px-6 py-4 border-t border-white/5 flex gap-3 shrink-0">
              <button
                onClick={create}
                disabled={saving || !form.title.trim() || !form.body.trim()}
                className="flex-1 py-3 rounded-xl font-semibold text-white text-sm transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: primaryColor }}
              >
                {(saving || uploadingImage) && <Loader2 className="w-4 h-4 animate-spin" />}
                {uploadingImage ? "Uploading image…" : saving ? "Posting…" : "Post Announcement"}
              </button>
              <button
                onClick={resetDrawer}
                className="px-5 py-3 rounded-xl font-medium text-gray-400 border border-white/10 hover:border-white/20 transition-colors text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
