"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { INK_MODES, PHOTO_MODES, type InkMode, type PhotoMode } from "@/lib/print/ink";

/**
 * The owner's controls for a card print run. Never printed itself.
 *
 * ## Why this exists
 *
 * Before it, `/print/member-cards` took a single optional `memberId` and
 * otherwise printed EVERY active member, in colour, with photos, with no
 * preview of what was about to come out of the printer. The only way to print a
 * chosen handful was to open one member at a time, and the only way to find out
 * what a run cost in ink was to run it.
 *
 * ## Why the ink choice is asked every time
 *
 * Noe's call: no remembered default. A club's answer legitimately changes per
 * run — full colour for a dozen new joiners, halftone for a 200-member
 * re-issue — and a sticky default is exactly how someone prints two hundred
 * cards in the wrong mode without noticing.
 *
 * The estimate shown is measured from THIS club's actual photos, not a generic
 * figure, because a club whose photos are dark gym selfies and one whose photos
 * are bright headshots have genuinely different answers.
 */
export interface PrintControlsProps {
  totalMembers: number;
  selectedCount: number;
  sheetCount: number;
  photoMode: PhotoMode;
  inkMode: InkMode;
  onPhotoMode: (m: PhotoMode) => void;
  onInkMode: (m: InkMode) => void;
  /** Percentage of full-colour ink this run will use, or null when unmeasurable. */
  inkPercent: number | null;
  /** How many of the selected members actually have a photo on file. */
  photosAvailable: number;
  photosProcessing: boolean;
  onPrint: () => void;
  children?: React.ReactNode;
}

function ModeRow<T extends string>({
  legend,
  hint,
  options,
  value,
  onChange,
}: {
  legend: string;
  hint?: string;
  options: ReadonlyArray<{ value: T; label: string; hint: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  const active = options.find((o) => o.value === value);
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
      <legend
        className="text-xs font-semibold uppercase tracking-wide mb-2"
        style={{ color: "var(--tx-3)" }}
      >
        {legend}
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            size="compact"
            variant={o.value === value ? "primary" : "secondary"}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {/* The hint follows the SELECTED option rather than sitting under every
          one: three permanent paragraphs of small print is how a panel becomes
          something people stop reading. */}
      <p className="text-xs mt-2" style={{ color: "var(--tx-3)", maxWidth: "62ch" }}>
        {hint ?? active?.hint}
      </p>
    </fieldset>
  );
}

export function PrintControls({
  totalMembers,
  selectedCount,
  sheetCount,
  photoMode,
  inkMode,
  onPhotoMode,
  onInkMode,
  inkPercent,
  photosAvailable,
  photosProcessing,
  onPrint,
  children,
}: PrintControlsProps) {
  const noPhotos = photoMode !== "photo";

  return (
    <div className="card-sheet-controls">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--tx-1)" }}>
            Print member cards
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-2)" }}>
            Two cards per A4 sheet. Check the preview below before you print — what you see is
            what comes out.
          </p>
        </div>
        {/* The accessible name stays "Print …" whatever the state. An earlier
            version swapped the label to "Preparing photos…" while the canvas
            work ran, which renamed the control mid-flight — three existing
            tests could no longer find it, and a screen-reader user would have
            lost the button just as surely. What it DOES belongs on the button;
            why it is briefly unavailable belongs beside it. */}
        <div className="flex items-center gap-3">
          {photosProcessing && (
            <span className="text-xs" style={{ color: "var(--tx-3)" }} role="status">
              Preparing photos…
            </span>
          )}
          <Button
            type="button"
            onClick={onPrint}
            disabled={selectedCount === 0 || photosProcessing}
          >
            <Printer aria-hidden="true" />
            Print {sheetCount} sheet{sheetCount === 1 ? "" : "s"}
          </Button>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <ModeRow
          legend="Picture"
          options={PHOTO_MODES}
          value={photoMode}
          onChange={onPhotoMode}
        />
        <ModeRow
          legend="Ink"
          options={INK_MODES}
          value={inkMode}
          onChange={onInkMode}
          hint={
            noPhotos
              ? "No pictures on these cards, so there is no photo ink to save."
              : undefined
          }
        />
      </div>

      {children}

      <div
        className="mt-5 pt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
        style={{ borderTop: "1px solid var(--bd-default)", color: "var(--tx-2)" }}
      >
        <span>
          <strong style={{ color: "var(--tx-1)" }}>{selectedCount}</strong> of {totalMembers}{" "}
          member{totalMembers === 1 ? "" : "s"}
        </span>
        <span>
          <strong style={{ color: "var(--tx-1)" }}>{sheetCount}</strong> A4 sheet
          {sheetCount === 1 ? "" : "s"}
        </span>
        {!noPhotos && (
          <span>
            {photosProcessing ? (
              "Measuring ink…"
            ) : photosAvailable === 0 ? (
              /* Not a failure, and it must not read as one. "Ink not measured"
                 sounded like something had gone wrong when the truth is simply
                 that nobody has uploaded a picture — and the cards will print
                 perfectly well with initials. Say that instead. */
              "No photos on file — these cards will print with initials"
            ) : inkPercent === null ? (
              "Ink could not be measured"
            ) : (
              <>
                about{" "}
                <strong style={{ color: "var(--tx-1)" }}>{inkPercent}%</strong> of the ink full
                colour would use
                {photosAvailable < selectedCount ? `, across ${photosAvailable} with photos` : ""}
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
