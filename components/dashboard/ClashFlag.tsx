import { AlertTriangle } from "lucide-react";

/**
 * The clash flag (session cover, round 4): the same person is shown teaching another session at the same time, one of
 * the two a cover. The words say it ("Clash: … is also teaching …", never colour alone, UI-RULES §8); warning ink on
 * its own white box with a warning border, so it reads on any card or tenant tint (§2); it wraps at phone width, and
 * it is focusable, so a keyboard user reaches the sentence — except inside a link (`focusable={false}`), whose own
 * focus already reads it.
 */
export function ClashFlag({ text, className = "", focusable = true }: { text: string; className?: string; focusable?: boolean }) {
  return (
    <p
      role="note"
      tabIndex={focusable ? 0 : undefined}
      className={`flex items-start gap-1 break-words rounded-[var(--r-sm)] border border-[var(--hue-warning)] bg-sf-1 px-1.5 py-0.5 text-xs font-medium text-[var(--hue-warning-ink)] ${className}`}
      data-testid="clash-flag"
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
