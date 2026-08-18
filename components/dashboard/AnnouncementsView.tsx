"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  Clock,
  Image as ImageIcon,
  Megaphone,
  Pin,
  Plus,
  Trash2,
  UploadCloud,
} from "lucide-react";

import { hex } from "@/lib/color";
import { formatDate, formatDateLong } from "@/lib/date";
import { linkify } from "@/lib/linkify";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet } from "@/components/ui/sheet";
import { StatusPill } from "@/components/ui/StatusPill";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";

/**
 * /dashboard/notifications — the announcements desk.
 *
 * Desktop is the §1.5.4 dense DataTable; the primitive collapses to the
 * original feed cards below `sm:` (§9). Both hand-rolled overlays — the
 * post detail and the create drawer — are now `Sheet` (§4a.3): each has
 * scrolling content, so the slide-over is the right shape, and the whole
 * accessibility contract (Escape, focus trap, scroll lock, labelling)
 * comes from the primitive.
 *
 * There is deliberately no "audience" column: announcements have no
 * targeting field, so a column of identical values would be decoration at
 * best and a fabricated capability at worst (§7).
 */

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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Relative age for the feed. Absolute dates come from lib/date (§10).
 *
 * Returns null past a week rather than falling back to `formatDate` — the
 * fallback made every row older than seven days print its date twice ("24 Apr
 * 2026 · 24 Apr 2026"), which is what the second line of the Posted cell was
 * full of. Callers render the separator only when there is something to add.
 */
function timeAgo(iso: string): string | null {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return null;
}

function buildColumns(
  primaryColor: string,
  canManage: boolean,
  deleting: string | null,
  onDelete: (a: AnnouncementRow) => void,
): DataTableColumn<AnnouncementRow>[] {
  const columns: DataTableColumn<AnnouncementRow>[] = [
    {
      key: "title",
      header: "Title",
      sortValue: (a) => a.title,
      cell: (a) => (
        // min-w-0 so the truncating title can actually shrink — without it the
        // cell's min-content width is the whole title and, now that cells are
        // nowrap by default, the table would widen instead of clipping.
        <div className="flex min-w-0 items-center gap-2">
          {a.pinned ? (
            <Pin
              className="size-3.5 shrink-0"
              style={{ color: primaryColor }}
              aria-hidden="true"
            />
          ) : null}
          <span className="truncate font-semibold text-tx-1">{a.title}</span>
        </div>
      ),
    },
    {
      key: "body",
      header: "Message",
      // The one legitimate `wrap` opt-out here: free-text of unbounded length
      // that has to be able to shrink. `line-clamp-1` still holds it to a
      // single line, so the row height is unaffected — without the opt-out its
      // min-content width would be the whole message and the table would
      // overflow rather than clip.
      wrap: true,
      cell: (a) => (
        <span className="line-clamp-1 text-tx-2">{a.body}</span>
      ),
    },
    {
      key: "createdAt",
      header: "Posted",
      width: "11rem",
      sortValue: (a) => new Date(a.createdAt),
      // ONE line (§4a.4): date-over-relative was a stacked cell, and a stacked
      // cell defeats --row-h-dense — it is why this table measured 55px
      // against a 36px spec. The relative age now trails the date inline, and
      // only when it says something the date does not.
      cell: (a) => {
        const ago = timeAgo(a.createdAt);
        return (
          <span className="whitespace-nowrap text-tx-2">
            {formatDate(a.createdAt)}
            {ago ? (
              <span suppressHydrationWarning className="ml-1 text-[11px] text-tx-3">
                · {ago}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "7rem",
      sortValue: (a) => (a.pinned ? 0 : 1),
      cell: (a) =>
        a.pinned ? (
          <StatusPill
            icon={Pin}
            label="Pinned"
            bg={hex(primaryColor, 0.14)}
            color={primaryColor}
          />
        ) : (
          <span className="text-[11px] text-tx-3">Posted</span>
        ),
    },
  ];

  if (canManage) {
    columns.push({
      key: "actions",
      header: "",
      headerLabel: "",
      align: "right",
      width: "6rem",
      cell: (a) => (
        <Button
          variant="ghost"
          size="compact"
          loading={deleting === a.id}
          aria-label={`Delete announcement: ${a.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(a);
          }}
        >
          {deleting === a.id ? null : (
            <Trash2 className="size-3.5" aria-hidden="true" />
          )}
          Delete
        </Button>
      ),
    });
  }

  return columns;
}

export default function AnnouncementsView({
  announcements: initial,
  primaryColor,
  role,
}: Props) {
  const { toast } = useToast();
  const [announcements, setAnnouncements] = useState(initial);
  const [showDrawer, setShowDrawer] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", pinned: false });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selected, setSelected] = useState<AnnouncementRow | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const imageId = useId();
  const pinnedId = useId();

  const canManage = ["owner", "manager"].includes(role);

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      toast("Image must be under 5MB", "error");
      return;
    }
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
          title: form.title.trim(),
          body: form.body.trim(),
          imageUrl: finalImageUrl,
          pinned: form.pinned,
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
        created.pinned ? [created, ...prev] : [...prev, created],
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
      if (!res.ok) {
        toast("Failed to delete", "error");
        return;
      }
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
      setSelected((current) => (current?.id === id ? null : current));
      toast("Deleted", "success");
    } finally {
      setDeleting(null);
    }
  }

  // Announcements were deleted on a single click, from BOTH the per-row button
  // in a dense 36px table and the Sheet footer — no confirm, no undo, the record
  // simply gone. Every sibling manager in this directory already gates its
  // destructive action behind this primitive.
  const [pendingDelete, setPendingDelete] = useState<AnnouncementRow | null>(null);

  const columns = useMemo(
    () => buildColumns(primaryColor, canManage, deleting, (a) => setPendingDelete(a)),
    // `remove` is a stable closure over setState only; re-creating the columns
    // on every render would defeat the table's sort memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primaryColor, canManage, deleting],
  );

  const inputCls =
    "w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2.5 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active";
  const labelCls = "mb-1.5 block text-xs font-medium text-tx-2";

  return (
    <div className="w-full">
      <PageHeader
        title="Announcements"
        description="Post updates to your gym community"
        action={
          canManage ? (
            <Button onClick={() => setShowDrawer(true)}>
              <Plus className="size-4" />
              New post
            </Button>
          ) : undefined
        }
      />

      {announcements.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Megaphone className="size-7" style={{ color: primaryColor }} />}
            title="No announcements yet"
            hint={
              canManage
                ? "Post your first announcement to keep members informed."
                : "Check back later for updates from your gym."
            }
            action={
              canManage ? (
                <Button onClick={() => setShowDrawer(true)}>
                  Post announcement
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        // No `overflow-hidden` — it would become the table's nearest scroll
        // container and make the sticky <thead> inert (see data-table.tsx).
        <div className="sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
          <DataTable
            label="Announcements"
            rows={announcements}
            rowKey={(a) => a.id}
            columns={columns}
            onRowClick={(a) => setSelected(a)}
            renderCard={(a) => (
              <Card padding="none" className="overflow-hidden text-left">
                {a.imageUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={toBlobProxyUrl(a.imageUrl) ?? a.imageUrl}
                    alt=""
                    className="h-32 w-full object-cover"
                  />
                ) : null}
                <div className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {a.pinned ? (
                      <StatusPill
                        icon={Pin}
                        label="Pinned"
                        bg={hex(primaryColor, 0.14)}
                        color={primaryColor}
                      />
                    ) : null}
                    <h3 className="text-sm font-semibold text-tx-1">{a.title}</h3>
                  </div>
                  <p className="line-clamp-3 text-[13px] leading-relaxed text-tx-2">
                    {a.body}
                  </p>
                  <div className="flex items-center gap-1 text-[11px] text-tx-3">
                    <Clock className="size-3" aria-hidden="true" />
                    {/* The mobile card has no date column beside it, so it
                        falls back to the absolute date once timeAgo runs out. */}
                    <span suppressHydrationWarning>
                      {timeAgo(a.createdAt) ?? formatDate(a.createdAt)}
                    </span>
                  </div>
                </div>
              </Card>
            )}
          />
        </div>
      )}

      {/* ── Post detail (§4a.3: scrolling content ⇒ Sheet) ── */}
      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ""}
        description={
          selected ? formatDateLong(selected.createdAt) : undefined
        }
        footer={
          canManage && selected ? (
            <Button
              variant="destructive"
              loading={deleting === selected.id}
              onClick={() => setPendingDelete(selected)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </Button>
          ) : undefined
        }
      >
        {selected ? (
          <div className="space-y-4">
            {selected.pinned ? (
              <StatusPill
                icon={Pin}
                label="Pinned"
                bg={hex(primaryColor, 0.14)}
                color={primaryColor}
              />
            ) : null}

            {selected.imageUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={toBlobProxyUrl(selected.imageUrl) ?? selected.imageUrl}
                alt=""
                className="w-full rounded-[var(--r-md)]"
              />
            ) : null}

            <p className="text-sm leading-relaxed whitespace-pre-wrap text-tx-2">
              {linkify(selected.body)}
            </p>
          </div>
        ) : null}
      </Sheet>

      {/* ── Create post (§4a.3: multi-field form ⇒ Sheet) ── */}
      <Sheet
        open={showDrawer}
        onClose={resetDrawer}
        title="New announcement"
        description="Members see this in their portal feed."
        footer={
          <>
            <Button variant="secondary" onClick={resetDrawer}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              loading={saving || uploadingImage}
              disabled={!form.title.trim() || !form.body.trim()}
            >
              {uploadingImage
                ? "Uploading image…"
                : saving
                  ? "Posting…"
                  : "Post announcement"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label htmlFor={titleId} className={labelCls}>
              Title *
            </label>
            <input
              id={titleId}
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Gym closed this Saturday"
              maxLength={120}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor={bodyId} className={labelCls}>
              Message *
            </label>
            <textarea
              id={bodyId}
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder="Write your announcement here…"
              rows={5}
              maxLength={2000}
              className={`${inputCls} resize-none`}
            />
            <p className="mt-1 text-right text-xs text-tx-3">
              {form.body.length}/2000
            </p>
          </div>

          <div>
            <label htmlFor={imageId} className={labelCls}>
              Image (optional)
            </label>
            <input
              id={imageId}
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageChange}
            />

            {imagePreview ? (
              <div className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="Selected announcement image"
                  className="h-40 w-full rounded-[var(--r-md)] object-cover"
                />
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    Replace
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => {
                      setImageFile(null);
                      setImagePreview(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              // Hand-rolled because no Button variant is a full-width dashed
              // drop target; everything else in this file uses the primitive.
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="flex w-full flex-col items-center gap-2 rounded-[var(--r-md)] border-2 border-dashed border-bd-default bg-sf-1 py-8 transition-colors hover:border-bd-hover"
              >
                <ImageIcon className="size-7 text-tx-3" aria-hidden="true" />
                <div className="text-center">
                  <p className="text-sm font-medium text-tx-2">Add an image</p>
                  <p className="mt-0.5 text-xs text-tx-3">
                    PNG, JPG, WebP · Max 5MB
                  </p>
                </div>
                <span className="mt-1 flex items-center gap-1.5 text-xs text-tx-3">
                  <UploadCloud className="size-3.5" aria-hidden="true" />
                  Click to upload
                </span>
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3">
            <div className="min-w-0">
              <label
                htmlFor={pinnedId}
                className="text-sm font-medium text-tx-1"
              >
                Pin to top
              </label>
              <p className="mt-0.5 text-xs text-tx-3">
                Pinned posts always appear first for members
              </p>
            </div>
            <Switch
              id={pinnedId}
              checked={form.pinned}
              onCheckedChange={(pinned) => setForm((f) => ({ ...f, pinned }))}
              aria-label="Pin to top"
            />
          </div>
        </div>
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await remove(pendingDelete.id);
          setPendingDelete(null);
        }}
        destructive
        title="Delete this announcement?"
        description={
          pendingDelete
            ? `"${pendingDelete.title}" will be removed for every member. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete announcement"
      />
    </div>
  );
}
