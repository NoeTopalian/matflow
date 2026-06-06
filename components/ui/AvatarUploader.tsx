"use client";

/**
 * AvatarUploader — wraps the Avatar component with file-picker + upload UX.
 *
 * Track A — Phase A3 (self-upload on /member/profile) and Phase A4 (staff
 * "Change picture" on /dashboard/members/[id]) use this same component so
 * the upload pipeline lives in exactly one place:
 *
 *   1. User picks a file (PNG / JPEG / WebP, ≤2 MB)
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
      fd.append("file", file);
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

  const buttonSizePx = size === "xl" ? 28 : 22;
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
            background: "rgba(15,16,20,0.92)",
            borderColor: "rgba(255,255,255,0.18)",
          }}
        >
          {uploading ? (
            <Loader2 className="w-3.5 h-3.5 text-gray-200 animate-spin" />
          ) : (
            <Camera className="w-3.5 h-3.5 text-gray-200" />
          )}
        </button>
        <input
          ref={inputRef}
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
      </div>
      {allowRemove && pictureUrl && (
        <button
          type="button"
          className="mt-2 text-xs underline-offset-4 hover:underline disabled:opacity-50"
          style={{ color: "rgba(255,255,255,0.45)" }}
          disabled={uploading || disabled}
          onClick={handleRemove}
        >
          Remove picture
        </button>
      )}
      {error && (
        <p className="mt-1 text-xs" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default AvatarUploader;
