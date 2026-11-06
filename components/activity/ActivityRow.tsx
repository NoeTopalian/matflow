"use client";

/**
 * How one activity entry is drawn — shared by the desktop table, the phone and
 * tablet cards and the embedded timelines, so an entry reads the same
 * everywhere. Everything shown comes from the server's entry
 * (lib/activity-types.ts `FeedEntry`): this file decides no wording, no link
 * and no permission. It only lays the pieces out:
 *
 *   the headline     the sentence, names as links, exactly as the club wrote them;
 *   the detail       what the sentence leaves out ("Reason: reset"), on its own line;
 *   the changes      one bullet per changed field, "Label: From → To" — or
 *                    "Label changed" when the reader may not see the values;
 *   who did it       "By Sean Coates" when the sentence does not already say so.
 *
 * The server writes the changes into the detail too (one run joined by " · ",
 * for the plain log and the screen-reader text). Those runs are recognised
 * here — against the entry's own `changes` list, or the server's "Fields:" and
 * "Also changed:" wording — and drawn as bullets instead. Anything not
 * recognised stays in the detail line exactly as sent, so a change of wording
 * on the server can cost a bullet, never a fact.
 */
import { Fragment, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { activityType, type FeedChange, type FeedEntry, type Part } from "@/lib/activity-types";
import { ActivityIcon } from "./activity-icons";

/**
 * A name inside a sentence. `display: inline` on purpose: the global 44px
 * touch floor applies to links laid out as boxes, and a boxed link in running
 * text would break the line and sit above its neighbours.
 */
const SUBJECT_LINK = "inline font-medium text-tx-1 underline decoration-[color:var(--bd-active)] underline-offset-2 hover:decoration-[color:var(--tx-1)]";
/** Up to this many changes are all shown; beyond it, the first few and a toggle. */
const ALL_CHANGES_UP_TO = 8;
const CHANGES_FOLDED = 6;
/** The type key of rows MatFlow support made: their Type already says who did it. */
const SUPPORT_TYPE = "support";

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

/** The type's icon and name. `wrap` lets a long name take a second line in a thin column instead of being cut off. */
export function ActivityTypeLabel({ typeKey, className, wrap = false }: { typeKey: string; className?: string; wrap?: boolean }) {
  const type = activityType(typeKey);
  const label = type?.label ?? "Activity";
  return (
    <span className={cn("flex min-w-0 gap-1.5 text-tx-2", wrap ? "items-start" : "items-center", className)} title={label}>
      {/* Failed payments are the one place colour means something on this page. */}
      <ActivityIcon name={type?.icon} className={cn("size-3.5 shrink-0", wrap && "mt-0.5", typeKey === "payment_failed" ? "text-[var(--hue-danger-ink)]" : "text-tx-3")} />
      <span className={wrap ? "min-w-0 break-words" : "truncate"}>{label}</span>
    </span>
  );
}

// ── Splitting the server's detail into a line and bullets ────────────────────

export type ChangeBullet = { label: string; from: string | null; to: string | null };

const isText = (part: Part): part is { text: string } => !("subject" in part);
const SEPARATOR = " · ";

/**
 * MatFlow's own words for a value — "off" → "Off". Anything else is what the
 * club or a person wrote ("de Souza", "iPhone", a plan's name) and is shown
 * exactly as sent, so a rename that only changes case still reads as one.
 */
const OWN_WORDS = new Set(["on", "off", "yes", "no", "true", "false", "none", "unlimited", "never", "always"]);
export function sentenceCase(value: string): string {
  return OWN_WORDS.has(value) ? value[0].toUpperCase() + value.slice(1) : value;
}

/** "Fields: Name, Phone" / "Also changed: Email" — the server's words for fields whose values are not shown. */
const FIELD_LIST = /^(?:Fields|Also changed): (.+)$/;

/**
 * The detail as a line (what the sentence leaves out) and bullets (what was changed).
 * Exported for the tests.
 */
export function splitDetail(entry: Pick<FeedEntry, "detail" | "changes">): { line: Part[] | null; bullets: ChangeBullet[] } {
  if (!entry.detail?.length) return { line: null, bullets: [] };
  // The detail's runs, split at the server's separator; a name stays inside the run it sits in.
  const runs: Part[][] = [[]];
  for (const part of entry.detail) {
    if (!isText(part)) {
      runs[runs.length - 1].push(part);
      continue;
    }
    part.text.split(SEPARATOR).forEach((piece, index) => {
      if (index > 0) runs.push([]);
      if (piece) runs[runs.length - 1].push({ text: piece });
    });
  }
  const changes: FeedChange[] = entry.changes ?? [];
  const bullets: ChangeBullet[] = [];
  const kept: Part[][] = [];
  for (const run of runs) {
    if (run.length === 0) continue;
    const said = run.every(isText) ? run.map((p) => (p as { text: string }).text).join("") : null;
    const change = said == null ? undefined : changes.find((c) => c.from != null && c.to != null && said === `${c.label}: ${c.from} → ${c.to}`);
    const listed = said == null ? null : FIELD_LIST.exec(said);
    if (change) bullets.push({ label: change.label, from: change.from, to: change.to });
    else if (listed) for (const label of listed[1].split(", ")) bullets.push({ label, from: null, to: null });
    else kept.push(run);
  }
  // What is left is said as the server joined it.
  const line = kept.flatMap((run, index) => (index > 0 ? [{ text: SEPARATOR }, ...run] : run));
  return { line: line.length ? line : null, bullets };
}

function Changes({ bullets }: { bullets: ChangeBullet[] }) {
  const [open, setOpen] = useState(false);
  const folded = bullets.length > ALL_CHANGES_UP_TO && !open;
  const shown = folded ? bullets.slice(0, CHANGES_FOLDED) : bullets;
  return (
    <>
      <ul className="list-disc space-y-0.5 pl-5 marker:text-tx-3" data-testid="activity-changes">
        {shown.map((bullet, index) => (
          <li key={`${bullet.label}-${index}`}>
            {bullet.from != null && bullet.to != null ? (
              <>
                <span className="text-tx-3">{bullet.label}:</span> {sentenceCase(bullet.from)} → {sentenceCase(bullet.to)}
              </>
            ) : (
              `${bullet.label} changed`
            )}
          </li>
        ))}
      </ul>
      {bullets.length > ALL_CHANGES_UP_TO ? (
        <Button type="button" variant="ghost" size="compact" className="-ml-2" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? "Show fewer changes" : `Show all ${bullets.length} changes`}
        </Button>
      ) : null}
    </>
  );
}

/** Who did it, when the sentence does not already say: a staff member by name, or where it came from. */
function Source({ entry }: { entry: FeedEntry }) {
  const { source } = entry;
  if (source.support) return null;
  if (source.staff) {
    return (
      <p data-testid="activity-source" className="text-tx-3">
        By{" "}
        <Link href={`/dashboard/activity?userId=${encodeURIComponent(source.staff.id)}`} className="inline text-tx-2 underline decoration-[color:var(--bd-active)] underline-offset-2 hover:decoration-[color:var(--tx-1)]">
          {source.staff.name}
        </Link>
      </p>
    );
  }
  // "Staff" with no name: the sentence already names the person.
  if (source.label === "Staff") return null;
  return (
    <p data-testid="activity-source" className="text-tx-3">
      {source.label}
    </p>
  );
}

/**
 * The whole description of one entry: the headline, the detail on its own
 * line, the changes as a real list, and who did it. Nothing is truncated: a
 * long class name takes the lines it needs.
 */
export function ActivityDescription({ entry, className }: { entry: FeedEntry; className?: string }) {
  const { line, bullets } = splitDetail(entry);
  return (
    <div className={cn("min-w-0 space-y-1 break-words text-[13px] leading-5 text-tx-2", className)}>
      <p>
        <span data-testid="activity-sentence" className={entry.undone ? "text-tx-3 line-through" : "text-tx-1"}>
          <Parts parts={entry.parts} />
        </span>
        {entry.undone ? (
          <>
            {" "}
            <span className="whitespace-nowrap rounded-full border border-bd-default px-1.5 py-0.5 text-[10px] font-semibold text-tx-2">Undone</span>
          </>
        ) : null}
        {/* Said once: a row typed "MatFlow support" already says who made it. */}
        {entry.source.support && entry.type !== SUPPORT_TYPE ? (
          <>
            {" "}
            <SupportPill />
          </>
        ) : null}
      </p>
      {line ? (
        <p data-testid="activity-detail" className="text-tx-3">
          <Parts parts={line} />
        </p>
      ) : null}
      {bullets.length ? <Changes bullets={bullets} /> : null}
      <Source entry={entry} />
    </div>
  );
}
