"use client";

import { useEffect, useRef, type RefObject } from "react";
import { X } from "lucide-react";
import { linkify } from "@/lib/linkify";

interface AnnouncementLink { label: string; url: string; }
interface Announcement {
  id: string;
  title: string;
  body: string;
  time: string;
  pinned: boolean;
  imageUrl?: string;
  links?: AnnouncementLink[];
}

interface Props {
  announcement: Announcement | null;
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement>;
}

const MODAL_TITLE_ID = "announcement-modal-title";

export default function AnnouncementModal({ announcement, onClose, triggerRef }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // ESC key + body scroll lock + focus management
  useEffect(() => {
    if (!announcement) return;

    // Focus the close button on open
    closeButtonRef.current?.focus();

    // Body scroll lock
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // ESC key listener
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevOverflow;
      // Return focus to the trigger element that opened the modal
      triggerRef?.current?.focus();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcement]);

  if (!announcement) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet / Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={MODAL_TITLE_ID}
        className="relative w-full md:max-w-lg rounded-t-3xl md:rounded-3xl flex flex-col overflow-hidden"
        style={{
          background: "var(--member-elevated, #111)",
          borderTop: "1px solid var(--member-elevated-border, rgba(255,255,255,0.1))",
          maxHeight: "90vh",
        }}
      >
        {/* Handle (mobile) */}
        <div className="flex justify-center pt-3 pb-1 shrink-0 md:hidden">
          <div className="w-10 h-1 rounded-full" style={{ background: "var(--member-text-dim, rgba(255,255,255,0.15))" }} />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-3 shrink-0">
          <h2
            id={MODAL_TITLE_ID}
            className="text-white font-bold text-lg leading-snug flex-1 pr-3"
          >
            {announcement.title}
          </h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white transition-colors shrink-0"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-4">
          {/* Image */}
          {announcement.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={announcement.imageUrl}
              alt={announcement.title}
              className="w-full rounded-2xl object-cover"
              style={{ maxHeight: 220 }}
            />
          )}

          {/* Body with linkified URLs */}
          <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">
            {linkify(announcement.body)}
          </p>

          {/* Explicit links array (if present) */}
          {announcement.links && announcement.links.length > 0 && (
            <div className="flex flex-col gap-2 pt-1">
              {announcement.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target={link.url.startsWith("/") ? undefined : "_blank"}
                  rel={link.url.startsWith("/") ? undefined : "noopener noreferrer"}
                  className="text-xs font-semibold underline underline-offset-2"
                  style={{ color: "var(--member-primary, #3b82f6)" }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}

          <p className="text-gray-600 text-xs">{announcement.time}</p>
        </div>
      </div>
    </div>
  );
}
