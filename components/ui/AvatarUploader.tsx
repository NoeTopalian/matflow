"use client";

/**
 * AvatarUploader — wraps the Avatar component with file-picker + upload UX.
 *
 * Track A — Phase A3 (self-upload on /member/profile) and Phase A4 (staff
 * "Change picture" on /dashboard/members/[id]) use this same component so
 * the upload pipeline lives in exactly one place:
 *
 *   1. User picks a file, which is downscaled in the browser first
 *      (lib/downscale-image.ts) — a phone photo is otherwise larger than both
 *      the route's ingress cap and Vercel's serverless request-body limit
 *   2. POST /api/upload?purpose=profile-pic with multipart { file, targetMemberId }
 *      — backend downscales to 256×256 WebP via sharp + strips EXIF
 *   3. PUT /api/members/[id]/profile-picture { url }
 *      — backend upserts the MemberPhoto row with kind='profile'
 *   4. onChange(newUrl) bubbles up so the parent updates its own state
 *
 * Optional "Remove" link calls DELETE on the same route.
 *
 * Errors are surfaced via the optional onError callback. The component does
 * NOT swallow them (a profile picture failing to save is the kind of thing
 * the user needs to see).
 */
import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Avatar, type AvatarSize } from "@/components/ui/Avatar";
import { downscaleImage, AVATAR_MAX_EDGE_PX } from "@/lib/downscale-image";

interface AvatarUploaderProps {
  memberId: string;
  name: string;
  pictureUrl: string | null;
  /** Stable per-entity colour seed for the initials fallback. */
  colorSeed?: string | null;
  size?: AvatarSize;
  /**
   * Called after a successful upload OR removal with the new URL (or null
   * after Remove). Parent components own the displayed state.
   */
  onChange: (newUrl: string | null) => void;
  /** Optional error callback. If omitted, errors render in a tiny tooltip below. */
  onError?: (message: string) => void;
  /** Show the "Remove picture" link beneath the avatar when one is set. */
  allowRemove?: boolean;
  /** Disable all controls (e.g. while the parent itself is mid-save). */
  disabled?: boolean;
  /** Optional label override for screen readers. */
  changeLabel?: string;
}

export function AvatarUploader({
  memberId,
  name,
  pictureUrl,
  colorSeed,
  size = "xl",
  onChange,
  onError,
  allowRemove = true,
  disabled = false,
  changeLabel,
}: AvatarUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showError = (message: string) => {
    if (onError) onError(message);
    else setError(message);
  };

  async function handleFile(file: File) {
    if (!memberId) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", await downscaleImage(file, AVATAR_MAX_EDGE_PX));
      fd.append("targetMemberId", memberId);
      const uploadRes = await fetch("/api/upload?purpose=profile-pic", {
        method: "POST",
        body: fd,
      });
      if (!uploadRes.ok) {
        const j = (await uploadRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Upload failed");
      }
      const { url } = (await uploadRes.json()) as { url: string };
      const putRes = await fetch(`/api/members/${memberId}/profile-picture`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!putRes.ok) {
        // Lane 1 iter-1 V-01 [Critical] fix: PUT failed AFTER the blob was
        // uploaded. The blob is now orphaned (Vercel Blob has no GC sweep) —
        // fire a best-effort cleanup so we don't accumulate storage bloat.
        // Errors here are intentionally swallowed: surfacing them would mask
        // the original PUT failure that the user actually cares about.
        void fetch("/api/upload/delete-orphan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        }).catch(() => {});
        const j = (await putRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Save failed");
      }
      const { profilePictureUrl } = (await putRes.json()) as {
        profilePictureUrl: string | null;
      };
      onChange(profilePictureUrl);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Couldn't upload");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    if (!memberId || !pictureUrl) return;
    setError(null);
    setUploading(true);
    try {
      const res = await fetch(`/api/members/${memberId}/profile-picture`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Couldn't remove");
      onChange(null);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Couldn't remove");
    } finally {
      setUploading(false);
    }
  }

  // Noe 2026-08-20: the camera chip read as too big and hard to see. Smaller,
  // and its colours come from tokens so it stays legible on BOTH shells — the
  // hardcoded near-black chip with text-gray-200 was tuned for the dark member
  // portal and washed out on the light staff dashboard.
  const buttonSizePx = size === "xl" ? 24 : 20;
  const buttonOffset = size === "xl" ? 0 : -2;

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <Avatar
          pictureUrl={pictureUrl}
          name={name}
          colorSeed={colorSeed ?? memberId}
          size={size}
          ring
        />
        <button
          type="button"
          aria-label={changeLabel ?? (pictureUrl ? "Change profile picture" : "Add profile picture")}
          disabled={uploading || disabled || !memberId}
          onClick={() => inputRef.current?.click()}
          className="absolute rounded-full flex items-center justify-center border-2 transition-opacity disabled:opacity-50"
          style={{
            bottom: buttonOffset,
            right: buttonOffset,
            width: buttonSizePx,
            height: buttonSizePx,
            background: "var(--color-primary)",
            borderColor: "var(--sf-1)",
            color: "var(--tx-on-accent)",
          }}
        >
          {uploading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Camera className="w-3 h-3" />
          )}
        </button>
        <input
          ref={inputRef}
          aria-label="Choose a profile picture to upload"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          disabled={uploading || disabled || !memberId}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
        {allowRemove && pictureUrl && (
          <button
            type="button"
            className="absolute left-1/2 -translate-x-1/2 top-full mt-1 whitespace-nowrap text-[11px] underline-offset-4 hover:underline disabled:opacity-50"
            style={{ color: "var(--tx-3)" }}
            disabled={uploading || disabled}
            onClick={handleRemove}
          >
            Remove picture
          </button>
        )}
      </div>
      {/* "Remove picture" used to render HERE, inside this flex-col, the moment
          a picture existed. Callers render the member's name AFTER
          <AvatarUploader>, so uploading a photo silently pushed a link between
          the face and the name — the mobile gap Noe reported, absent before
          upload because pictureUrl was null. It was also rgba(255,255,255,0.45)
          white-alpha, near-invisible on the light staff shell (UI-RULES §4a)
          while still taking the space.

          It now sits absolutely inside the avatar's own relative box, directly
          under the image, so it occupies no layout height and can never
          separate the avatar from whatever follows it. */}
      {error && (
        <p role="alert" className="mt-1 text-xs" style={{ color: "var(--member-danger, var(--hue-danger-ink))" }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default AvatarUploader;
