/**
 * What Settings → Waiver's editor opens with, and what it saves.
 *
 * End-user round 2 (1.9): "Edit Waiver" opened with an empty title and text
 * while the owner was looking at the default wording, so editing meant
 * retyping the whole waiver. The editor now opens with the club's own text,
 * or — when there is none — the exact default the server would record for
 * this club (lib/default-waiver.ts, the builders app/api/waiver/* use).
 *
 * Saving text identical to that default stores null, so an owner who opens
 * the editor and presses Save without changing anything stays on the default
 * (which follows the club's name) rather than freezing a copy of it.
 */
import {
  buildDefaultKidsWaiverContent,
  buildDefaultKidsWaiverTitle,
  buildDefaultWaiverContent,
  buildDefaultWaiverTitle,
} from "@/lib/default-waiver";

export type WaiverKind = "adult" | "kids";
export type WaiverText = { title: string; content: string };

export function defaultWaiverText(kind: WaiverKind, gymName?: string | null): WaiverText {
  return kind === "kids"
    ? { title: buildDefaultKidsWaiverTitle(), content: buildDefaultKidsWaiverContent(gymName) }
    : { title: buildDefaultWaiverTitle(gymName), content: buildDefaultWaiverContent(gymName) };
}

/** The editor's starting values: the club's saved text, else the default. */
export function waiverEditorStart(
  kind: WaiverKind,
  saved: { title?: string | null; content?: string | null },
  gymName?: string | null,
): WaiverText {
  const fallback = defaultWaiverText(kind, gymName);
  return {
    title: saved.title?.trim() ? saved.title : fallback.title,
    content: saved.content?.trim() ? saved.content : fallback.content,
  };
}

/** What to PATCH: null for a field that is empty or identical to the default. */
export function waiverSaveValues(
  kind: WaiverKind,
  edited: WaiverText,
  gymName?: string | null,
): { title: string | null; content: string | null } {
  const fallback = defaultWaiverText(kind, gymName);
  const title = edited.title.trim();
  const content = edited.content.trim();
  return {
    title: !title || title === fallback.title.trim() ? null : edited.title,
    content: !content || content === fallback.content.trim() ? null : edited.content,
  };
}
