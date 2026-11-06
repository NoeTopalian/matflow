"use client";

/**
 * How one activity entry is drawn — shared by the desktop table cell, the
 * phone card and the embedded timelines, so a sentence reads the same
 * everywhere. Everything shown comes from the server's entry
 * (lib/activity-types.ts `FeedEntry`): this file decides no wording, no link
 * and no permission.
 */
import { Fragment } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { activityType, type FeedEntry, type Part } from "@/lib/activity-types";
import { ActivityIcon } from "./activity-icons";

/**
 * A name inside a sentence. `display: inline` on purpose: the global 44px
 * touch floor applies to links laid out as boxes, and a boxed link in running
 * text would break the line and sit above its neighbours.
 */
const SUBJECT_LINK = "inline font-medium text-tx-1 underline decoration-[color:var(--bd-active)] underline-offset-2 hover:decoration-[color:var(--tx-1)]";

function Parts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (!("subject" in part)) return <Fragment key={index}>{part.text}</Fragment>;
        const { subject } = part;
        return (
          <Fragment key={index}>
            {subject.href ? (
              <Link href={subject.href} className={SUBJECT_LINK}>
                {subject.name}
              </Link>
            ) : subject.gone ? (
              // Someone or something that is gone: said plainly, never dressed as a name to follow.
              subject.name
            ) : (
              <span className="font-medium text-tx-1">{subject.name}</span>
            )}
            {part.possessive ? "'s" : null}
          </Fragment>
        );
      })}
    </>
  );
}

export function SupportPill() {
  return (
    <span
      className="whitespace-nowrap rounded-full border border-bd-default bg-sf-2 px-1.5 py-0.5 text-[10px] font-semibold text-tx-2"
      title="This change was made by MatFlow support during a support session, not by your staff."
    >
      by MatFlow support
    </span>
  );
}

/** The type's icon and name: the "Type" column, and the first line of a phone card. */
export function ActivityTypeLabel({ typeKey, className }: { typeKey: string; className?: string }) {
  const type = activityType(typeKey);
  const label = type?.label ?? "Activity";
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-tx-2", className)} title={label}>
      {/* Failed payments are the one place colour means something on this page. */}
      <ActivityIcon name={type?.icon} className={cn("size-3.5 shrink-0", typeKey === "payment_failed" ? "text-[var(--hue-danger-ink)]" : "text-tx-3")} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The sentence, then its detail, then where it came from — one paragraph that
 * wraps freely. Nothing is truncated: a long class name or a list of changed
 * fields takes the lines it needs.
 */
export function ActivitySentence({ entry, className }: { entry: FeedEntry; className?: string }) {
  return (
    <p className={cn("min-w-0 break-words text-[13px] leading-5 text-tx-2", className)}>
      <span data-testid="activity-sentence" className={entry.undone ? "text-tx-3 line-through" : undefined}>
        <Parts parts={entry.parts} />
      </span>
      {entry.undone ? (
        <>
          {" "}
          <span className="whitespace-nowrap rounded-full border border-bd-default px-1.5 py-0.5 text-[10px] font-semibold text-tx-2">Undone</span>
        </>
      ) : null}
      {entry.detail ? (
        <span data-testid="activity-detail" className="text-tx-3">
          {" · "}
          <Parts parts={entry.detail} />
        </span>
      ) : null}
      {entry.source.support ? (
        <>
          {" "}
          <SupportPill />
        </>
      ) : (
        <span data-testid="activity-source" className="text-tx-3">
          {" · "}
          {entry.source.label}
          {entry.source.staff ? (
            <>
              {" · "}
              <Link href={`/dashboard/activity?userId=${encodeURIComponent(entry.source.staff.id)}`} className="inline text-tx-2 underline decoration-[color:var(--bd-active)] underline-offset-2 hover:decoration-[color:var(--tx-1)]">
                {entry.source.staff.name}
              </Link>
            </>
          ) : null}
        </span>
      )}
    </p>
  );
}
