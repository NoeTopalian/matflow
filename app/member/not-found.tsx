import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/**
 * The member shell's own 404 (UI-RULES §7: an HTTP error is never a blank).
 *
 * Before this file existed, a child page reached with an id that is not one
 * of this parent's children (`app/member/family/[childId]` calls `notFound()`)
 * fell through to Next's default "404 | This page could not be found." — a
 * bare white page with no shell, no club and no way back. Found by lh-5
 * B-06 on 26 Sep 2026. The copy does not say whether the id exists for
 * another family: the route answers the same 404 either way, and so does
 * this page.
 */
export default function MemberNotFound() {
  return (
    <div className="px-4 py-12 flex flex-col items-center text-center gap-3">
      <p className="text-white text-lg font-bold">We couldn&apos;t find that page</p>
      <p className="text-sm max-w-xs" style={{ color: "var(--member-text-muted)" }}>
        It may have been removed, or it isn&apos;t part of your account. Nothing on your account has changed.
      </p>
      <Link
        href="/member/profile"
        className="mt-2 inline-flex items-center gap-1 text-sm font-semibold"
        style={{ color: "var(--color-primary)" }}
      >
        <ChevronLeft className="w-4 h-4" /> Back to profile
      </Link>
    </div>
  );
}
