"use client";

/**
 * MemberCardSheet — the printable sheet of laminated member ID cards.
 *
 * A5 cards, two to an A4 portrait sheet, with a cut line between them.
 * Everything here is calibrated in millimetres because the output is a
 * physical object: 210mm × 148.5mm per card, a 35mm QR, and a page box that
 * the browser's print dialogue must not rescale.
 *
 * FOUR FAILURE STATES, ALL VISIBLE (UI-RULES §7)
 * ----------------------------------------------
 * 1. QR generation fails for a member → that card is EXCLUDED from the sheet
 *    and the member is named in a staff-visible banner. On a card the QR *is*
 *    the function; a blank square laminates fine and is discovered on the mat
 *    days later, by which point the sheet has been cut up and handed out.
 * 2. A photo fails to LOAD → the monogram renders (so the card is still
 *    usable) but the failure is counted and reported. A failed load is not the
 *    same fact as "no photo uploaded": a systemic 401 from /api/blob-image
 *    would otherwise read as "nobody has uploaded a picture", and staff would
 *    print two hundred monograms without ever knowing.
 * 3. A member has no grade → the card prints an explicit "Ungraded" state and
 *    the count is surfaced before printing. This is the COMMON case, not an
 *    edge case, because the member importer carries no rank data. A laminated
 *    card asserting a belt nobody awarded is a factual misstatement handed to
 *    a person.
 * 4. The club logo fails to LOAD → every card falls back to the club name as
 *    text and one banner says so. The same 401 that loses one member's photo
 *    loses the logo on all 300 cards at once, so this is the larger blast
 *    radius of the two, not the smaller.
 *
 * Why the card's own colours are named CSS colours rather than tokens: the
 * card is ink on paper. Paper is not themeable and a printer has no dark mode,
 * so the surface tokens (which follow the shell) would produce a card that
 * changes with the viewer's theme. The surrounding toolbar and banners — real
 * chrome — use tokens as normal.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Belt, isUngraded, type BeltRank } from "@/components/ui/Belt";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { initials } from "@/lib/initials";
import { Checkbox } from "@/components/ui/checkbox";
import { PrintControls } from "@/components/print/PrintControls";
import {
  relativeInkPercent,
  type InkMode,
  type PhotoMode,
} from "@/lib/print/ink";
import { processPhoto } from "@/lib/print/process-photo";

export type PrintCardMember = {
  id: string;
  name: string;
  /** Signed card token (lib/card-token.ts) — minted on the server, encoded as the QR. */
  cardToken: string;
  /** Raw stored URL; routed through the authenticated proxy here. */
  photoUrl: string | null;
  rank: BeltRank | null;
};

export type PrintCardClub = {
  name: string;
  /** Raw stored URL, or null. A null logo prints the club name as text. */
  logoUrl: string | null;
};

/**
 * Set when the query hit `CARD_LIMIT` and did not return the whole club. The
 * sheet has to say so: "300 cards across 150 A4 sheets" is a true statement
 * about the paper and a false one about the membership, and the members who
 * fell off the end are discovered only when they ask where their card is.
 */
export type PrintCardTruncation = {
  /** Cards on this sheet. */
  shown: number;
  /** Members who matched the filter in total. */
  total: number;
};

/**
 * QR geometry, measured rather than guessed. A realistic token (cuid tenantId +
 * cuid memberId + 5-year expiry) is 216 characters, which the `qrcode` package
 * encodes as version 11 — 61 x 61 modules, 63 including the one-module quiet
 * zone. At the original 35mm that is 0.556mm per module, the bottom of the
 * range a handheld phone resolves reliably, and lamination adds glare on top.
 * 45mm puts it at 0.714mm.
 *
 * Raising `errorCorrectionLevel` was the other candidate and is NOT taken:
 * level Q needs version 13 (69 modules), which at a fixed 45mm shrinks each
 * module back to 0.634mm. Physical module size is the binding constraint here,
 * so the extra recovery would cost more than it buys.
 */
const QR_MM = 45;
/**
 * `scale` (px PER MODULE), not `width` (px total). A fixed width of 480 over 63
 * modules gave 7.619px per module — a fractional raster, so modules came out
 * unevenly 7px or 8px wide and `imageRendering: pixelated` then locked that
 * jitter in instead of letting the printer smooth it away.
 */
const QR_MODULE_PX = 8;

type QrState =
  | { status: "pending" }
  | { status: "ready"; codes: Record<string, string>; failedIds: string[] }
  | { status: "error" };

export function MemberCardSheet({
  club,
  members,
  truncation = null,
}: {
  club: PrintCardClub;
  members: PrintCardMember[];
  truncation?: PrintCardTruncation | null;
}) {
  const [qr, setQr] = useState<QrState>({ status: "pending" });

  // Asked fresh every run, never remembered. A club's honest answer changes
  // between a dozen new joiners and a 200-card re-issue, and a sticky default is
  // how someone prints two hundred cards in the wrong mode without noticing.
  const [photoMode, setPhotoMode] = useState<PhotoMode>("photo");
  const [inkMode, setInkMode] = useState<InkMode>("colour");

  // null = "everyone". A Set only appears once the owner narrows it, so the
  // default run is unchanged from before this screen existed.
  const [chosenIds, setChosenIds] = useState<Set<string> | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");

  const [processed, setProcessed] = useState<Record<string, string>>({});
  const [inkPercent, setInkPercent] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [photoFailedIds, setPhotoFailedIds] = useState<string[]>([]);
  // One logo serves every card, so a failed load is not a per-card count — it
  // is a single fact with a sheet-wide blast radius, and it must not print as
  // a broken-image glyph on all 300 cards.
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const codes: Record<string, string> = {};
        const failedIds: string[] = [];
        for (const m of members) {
          try {
            codes[m.id] = await QRCode.toDataURL(m.cardToken, {
              scale: QR_MODULE_PX,
              margin: 1,
              errorCorrectionLevel: "M",
            });
          } catch {
            // Per-member failure: drop this ONE card, keep the rest of the
            // sheet printable, and name the member in the banner below.
            failedIds.push(m.id);
          }
        }
        if (!cancelled) setQr({ status: "ready", codes, failedIds });
      } catch {
        // The qrcode module itself did not load — no card on this sheet can
        // carry a working code, so nothing is offered for printing at all.
        if (!cancelled) setQr({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [members]);

  // Bake the chosen ink treatment into the pixels.
  //
  // A CSS filter would be simpler and is not enough: there is no CSS for
  // halftoning, and a filter is a rendering hint, so what reaches the printer is
  // still the full-colour original. Browsers disagree about whether to honour it
  // on paper. Baking means the sheet prints what the preview showed.
  //
  // Re-runs when the mode changes, which is the point — the owner is choosing
  // and watching the estimate move.
  useEffect(() => {
    let cancelled = false;

    if (photoMode !== "photo") {
      setProcessed({});
      setInkPercent(null);
      setProcessing(false);
      return;
    }

    const withPhotos = members.filter((m) => !!m.photoUrl);
    if (withPhotos.length === 0) {
      setProcessed({});
      setInkPercent(null);
      setProcessing(false);
      return;
    }

    setProcessing(true);
    (async () => {
      const next: Record<string, string> = {};
      let colourTotal = 0;
      let appliedTotal = 0;
      let measured = 0;

      for (const m of withPhotos) {
        const src = toBlobProxyUrl(m.photoUrl);
        if (!src) continue;
        try {
          const out = await processPhoto(src, inkMode);
          next[m.id] = out.src;
          colourTotal += out.inkColour;
          appliedTotal += out.inkApplied;
          measured++;
        } catch {
          // One member's photo could not be read or processed. Fall through to
          // the existing photo-failure path — which COUNTS the failure and
          // names it in a banner — rather than inventing a second, quieter one.
          markPhotoFailed(m.id);
        }
      }

      if (cancelled) return;
      setProcessed(next);
      setInkPercent(measured > 0 ? relativeInkPercent(colourTotal, appliedTotal) : null);
      setProcessing(false);
    })();

    return () => {
      cancelled = true;
    };
    // markPhotoFailed is a stable setState wrapper declared below; including it
    // would need a useCallback whose only purpose is to satisfy the linter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, photoMode, inkMode]);

  if (qr.status === "error") {
    return (
      <div className="p-8">
        <ErrorState
          message="Couldn't generate the QR codes, so no cards can be printed yet. Reload to try again."
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  if (qr.status === "pending") {
    return (
      <div className="p-8 text-sm" style={{ color: "var(--tx-2)" }}>
        Generating codes…
      </div>
    );
  }

  // A card is printable when it has a working QR AND the owner has not excluded
  // the member. Selection narrows the sheet; it never widens it past what the
  // server already scoped to this tenant.
  const selectable = members.filter((m) => qr.codes[m.id]);
  const printable = chosenIds
    ? selectable.filter((m) => chosenIds.has(m.id))
    : selectable;
  const excluded = members.filter((m) => qr.failedIds.includes(m.id));
  const withPhoto = photoMode === "photo" ? printable.filter((m) => !!m.photoUrl) : [];
  const matchingQuery = query.trim()
    ? selectable.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase()))
    : selectable;
  const isChosen = (id: string) => (chosenIds ? chosenIds.has(id) : true);

  function toggleMember(id: string) {
    setChosenIds((prev) => {
      const next = new Set(prev ?? selectable.map((m) => m.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const photoFailures = withPhoto.filter((m) => photoFailedIds.includes(m.id));
  const ungraded = printable.filter((m) => isUngraded(m.rank));

  function markPhotoFailed(id: string) {
    setPhotoFailedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function markLogoFailed() {
    setLogoFailed(true);
  }

  const sheets: PrintCardMember[][] = [];
  for (let i = 0; i < printable.length; i += 2) sheets.push(printable.slice(i, i + 2));

  return (
    <div className="card-sheet-root">
      <style>{`
        @page { size: A4 portrait; margin: 0; }

        .card-sheet-page {
          width: 210mm;
          height: 297mm;
          display: flex;
          flex-direction: column;
          background: white;
          margin: 0 auto 8mm;
          box-shadow: 0 1px 3px rgba(0,0,0,0.18);
        }
        .card-sheet-cut {
          border-top: 1px dashed rgba(0,0,0,0.45);
          height: 0;
          /* Taken out of flow. The rule is a 1px border box; left in the column
             it pushed the page past 297mm, the cards shrank sub-pixel to
             compensate (so the cut no longer fell on the true half) and Chrome
             emitted a trailing blank page per sheet. */
          margin-top: -1px;
        }
        .card-sheet-card {
          width: 210mm;
          height: 148.5mm;
          /* Never shrink to absorb a rounding error: two cards ARE the page. */
          flex: none;
          box-sizing: border-box;
          /* Two cards sum to exactly 297mm, so there is no slack at all. Any
             environment whose usable page box is even fractionally smaller —
             Safari, which imposes its own margins regardless of @page; a user
             who picks "Minimum" or "Custom" margins in Chrome; Firefox's
             shrink-to-fit — would otherwise guillotine the second card across
             two physical sheets, a sliver on one and the remainder on the
             next. Pushing the whole card to the next sheet is a wasted page;
             splitting one is a wasted print run. */
          break-inside: avoid;
          page-break-inside: avoid;
          padding: 12mm 14mm;
          display: flex;
          align-items: center;
          gap: 12mm;
          background: white;
          color: black;
          overflow: hidden;
        }

        /* WITHOUT THIS THE BELT PRINTS THE INVERSE OF THE MEMBER'S GRADE.
           Browsers drop CSS backgrounds and box-shadows when printing unless
           the user ticks "Background graphics"; borders, text and <img> are
           unaffected. The belt bar is a background, its dark tab is an inset
           box-shadow and an EARNED stripe is a background — while an UNEARNED
           slot is a border. So on default print settings the belt vanishes,
           the earned stripes vanish, and only the empty slots survive: a
           laminated card understating the grade of the person holding it.
           Declared outside @media print as well, because Chrome's print
           preview and "Save as PDF" both honour it at paint time. */
        .card-sheet-root, .card-sheet-root * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        /* THE PAPER IS 210mm AND THE SCREEN OFTEN IS NOT.
           210mm is 793.7px, so on a tablet at 768 — or any laptop with a side
           panel open — the sheet used to push the whole DOCUMENT to a
           scrollWidth of 794 and take the chrome with it: the Print button,
           the mode toggles and the member picker all slid out from under the
           pointer, on the one screen whose entire job is "check this, then
           press Print".
           Shrinking the sheet is not the fix. A preview that is not true size
           is a preview that lies about where the guillotine falls, and this
           component's whole premise (see the header) is that what you see is
           the physical object. So the SHEETS get their own scrolling band and
           the page stops moving. Screen only — @media print puts it back to
           visible so nothing can clip a card at paint time. */
        .card-sheet-preview {
          overflow-x: auto;
          overscroll-behavior-x: contain;
        }

        @media print {
          .card-sheet-chrome { display: none !important; }
          .card-sheet-preview { overflow: visible !important; }
          .card-sheet-page {
            margin: 0;
            box-shadow: none;
            page-break-after: always;
            break-after: page;
          }
          .card-sheet-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }
          .card-sheet-root { background: white; }
        }
      `}</style>

      <div className="card-sheet-chrome px-6 py-5">
        <PrintControls
          totalMembers={selectable.length}
          selectedCount={printable.length}
          sheetCount={sheets.length}
          photoMode={photoMode}
          inkMode={inkMode}
          onPhotoMode={setPhotoMode}
          onInkMode={setInkMode}
          inkPercent={inkPercent}
          photosAvailable={withPhoto.length}
          photosProcessing={processing}
          onPrint={() => window.print()}
        >
          <div className="mt-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="compact"
                variant={chosenIds === null ? "primary" : "secondary"}
                aria-pressed={chosenIds === null}
                onClick={() => {
                  setChosenIds(null);
                  setPickerOpen(false);
                }}
              >
                Everyone ({selectable.length})
              </Button>
              <Button
                type="button"
                size="compact"
                variant={chosenIds === null ? "secondary" : "primary"}
                aria-pressed={chosenIds !== null}
                aria-expanded={pickerOpen}
                onClick={() => {
                  setPickerOpen((v) => !v);
                  if (chosenIds === null) setChosenIds(new Set(selectable.map((m) => m.id)));
                }}
              >
                Choose members{chosenIds === null ? "" : ` (${printable.length})`}
              </Button>
            </div>

            {pickerOpen && (
              <div
                className="mt-3 rounded-[var(--r-md)] border p-3"
                style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}
              >
                {/* Explicit htmlFor/id rather than a wrapping <label>. A wrapping
                    label IS valid and does name the control in a real browser —
                    the Playwright case finds it with getByLabel — but
                    tests/unit/input-accessible-names.test.ts reads source, not a
                    rendered tree, and only understands aria-label,
                    aria-labelledby, title, or an id matched by an htmlFor. An
                    explicit pair satisfies both, and is what the rest of the
                    codebase already does. Adding this file to that test's
                    allow-list would have been the other way to make it pass, and
                    the wrong one. */}
                <label
                  htmlFor="print-card-search"
                  className="block text-xs font-semibold mb-1"
                  style={{ color: "var(--tx-3)" }}
                >
                  Search members
                </label>
                <input
                  id="print-card-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Type a name"
                  className="mb-2 w-full rounded-[var(--r-md)] border bg-transparent px-3 py-2 text-sm outline-none"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />

                <div className="flex gap-2 mb-2">
                  <Button
                    type="button"
                    size="compact"
                    variant="secondary"
                    onClick={() => setChosenIds(new Set(selectable.map((m) => m.id)))}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="secondary"
                    onClick={() => setChosenIds(new Set())}
                  >
                    Clear
                  </Button>
                </div>

                {/* Capped height so a 300-member club does not push the preview
                    off the screen — the preview is the thing being decided on. */}
                <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
                  {matchingQuery.length === 0 ? (
                    <p className="text-sm py-2" style={{ color: "var(--tx-3)" }}>
                      No members match “{query}”.
                    </p>
                  ) : (
                    matchingQuery.map((m) => (
                      <label
                        key={m.id}
                        className="flex items-center gap-2 text-sm py-1 cursor-pointer"
                        style={{ color: "var(--tx-1)" }}
                      >
                        <Checkbox
                          checked={isChosen(m.id)}
                          onCheckedChange={() => toggleMember(m.id)}
                          aria-label={m.name}
                        />
                        {m.name}
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </PrintControls>

        {/* UI-RULES §8: the photo- and logo-failure banners appear
            asynchronously, after image onError events that fire long after
            first paint, so a screen reader is never told the sheet changed
            unless this region announces it. */}
        <div className="mt-4 flex flex-col gap-2" aria-live="polite">
          {truncation && (
            <p
              data-testid="truncation-banner"
              className="rounded-[var(--r-md)] border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--hue-warning)",
                color: "var(--hue-warning-ink)",
                background: "var(--sf-1)",
              }}
            >
              Showing the first {truncation.shown} of {truncation.total} members. The remaining{" "}
              {truncation.total - truncation.shown} have no card on this sheet — print them by
              narrowing the list or by opening a single member&rsquo;s card.
            </p>
          )}

          {excluded.length > 0 && (
            <p
              data-testid="qr-excluded-banner"
              className="rounded-[var(--r-md)] border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--hue-danger)",
                color: "var(--hue-danger-ink)",
                background: "var(--sf-1)",
              }}
            >
              {excluded.length} of {members.length}{" "}
              {excluded.length === 1 ? "card was" : "cards were"} left out because the QR code could
              not be generated: {excluded.map((m) => m.name).join(", ")}. Those members cannot be
              scanned, so nothing is printed for them.
            </p>
          )}

          {photoFailures.length > 0 && (
            <p
              data-testid="photo-failure-banner"
              className="rounded-[var(--r-md)] border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--hue-warning)",
                // §2: --hue-warning-ink is the one ink that does not clear the
                // contrast floor on the zebra surface, so this banner sits on
                // white (--sf-1), never --sf-0/--sf-2.
                color: "var(--hue-warning-ink)",
                background: "var(--sf-1)",
              }}
            >
              {photoFailures.length} of {withPhoto.length} photos could not be loaded — check before
              printing. Those cards show initials instead.
            </p>
          )}

          {logoFailed && (
            <p
              data-testid="logo-failure-banner"
              className="rounded-[var(--r-md)] border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--hue-warning)",
                color: "var(--hue-warning-ink)",
                background: "var(--sf-1)",
              }}
            >
              The club logo could not be loaded — check before printing. Every card on this sheet
              prints the club name as text instead.
            </p>
          )}

          {ungraded.length > 0 && (
            <p
              data-testid="ungraded-banner"
              className="rounded-[var(--r-md)] border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--bd-default)",
                color: "var(--tx-2)",
                background: "var(--sf-1)",
              }}
            >
              {ungraded.length} of {printable.length}{" "}
              {ungraded.length === 1 ? "member has" : "members have"} no grade recorded, so{" "}
              {ungraded.length === 1 ? "their card prints" : "their cards print"} as ungraded rather
              than claiming a belt: {ungraded.map((m) => m.name).join(", ")}.
            </p>
          )}
        </div>
      </div>

      <div className="card-sheet-preview">
      {sheets.map((pair, sheetIndex) => (
        <div className="card-sheet-page" key={sheetIndex}>
          <MemberCard
            club={club}
            member={pair[0]}
            qrDataUrl={qr.codes[pair[0].id]}
            photoFailed={photoFailedIds.includes(pair[0].id)}
            onPhotoError={markPhotoFailed}
            logoFailed={logoFailed}
            onLogoError={markLogoFailed}
            photoMode={photoMode}
            processedSrc={processed[pair[0].id] ?? null}
          />
          <div className="card-sheet-cut" aria-hidden="true" />
          {pair[1] ? (
            <MemberCard
              club={club}
              member={pair[1]}
              qrDataUrl={qr.codes[pair[1].id]}
              photoFailed={photoFailedIds.includes(pair[1].id)}
              onPhotoError={markPhotoFailed}
              logoFailed={logoFailed}
              onLogoError={markLogoFailed}
              photoMode={photoMode}
              processedSrc={processed[pair[1].id] ?? null}
            />
          ) : (
            // The odd card out. An empty half-sheet is printed blank rather
            // than filled, so the cut line stays where the guillotine expects.
            <div className="card-sheet-card" aria-hidden="true" />
          )}
        </div>
      ))}
      </div>
    </div>
  );
}

function MemberCard({
  club,
  member,
  qrDataUrl,
  photoFailed,
  onPhotoError,
  logoFailed,
  onLogoError,
  photoMode,
  processedSrc,
}: {
  club: PrintCardClub;
  member: PrintCardMember;
  qrDataUrl: string;
  photoFailed: boolean;
  onPhotoError: (id: string) => void;
  logoFailed: boolean;
  onLogoError: () => void;
  photoMode: PhotoMode;
  /** The ink-treated photo. Null when untreated, absent, or still processing. */
  processedSrc: string | null;
}) {
  // No `?? member.photoUrl` fallback: toBlobProxyUrl returns non-blob input
  // unchanged and is nullish only when its input already was, so the arm could
  // never fire and only implied a fallback that does not exist.
  // "photo" is the only mode that reaches for an image at all. "initials" is a
  // deliberate choice rather than a fallback, and "none" drops the block
  // entirely — the card is a flex row, so name, belt and QR simply take the
  // width back. All three are first-class: "optional for image or just name".
  const wantsImage = photoMode === "photo";
  const photoSrc = !wantsImage || photoFailed ? null : processedSrc ?? toBlobProxyUrl(member.photoUrl);
  const showPictureBlock = photoMode !== "none";
  const logoSrc = logoFailed ? null : toBlobProxyUrl(club.logoUrl);

  return (
    <div className="card-sheet-card" data-testid={`card-${member.id}`}>
      {showPictureBlock && (
      <div
        style={{
          width: "38mm",
          height: "38mm",
          flexShrink: 0,
          borderRadius: "3mm",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0,0,0,0.06)",
          border: "0.4mm solid rgba(0,0,0,0.14)",
        }}
      >
        {photoSrc ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={photoSrc}
            alt={member.name}
            data-testid={`photo-${member.id}`}
            onError={() => onPhotoError(member.id)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span
            data-testid={`monogram-${member.id}`}
            role="img"
            aria-label={member.name}
            style={{
              fontSize: "14mm",
              fontWeight: 700,
              letterSpacing: "0.02em",
              color: "rgba(0,0,0,0.55)",
              userSelect: "none",
            }}
          >
            {initials(member.name)}
          </span>
        )}
      </div>
      )}

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "4mm" }}>
        {logoSrc ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={logoSrc}
            alt={club.name}
            data-testid={`logo-${member.id}`}
            onError={onLogoError}
            style={{ height: "12mm", maxWidth: "60mm", objectFit: "contain", alignSelf: "flex-start" }}
          />
        ) : (
          <span
            data-testid={`club-name-${member.id}`}
            style={{
              fontSize: "5mm",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "rgba(0,0,0,0.72)",
            }}
          >
            {club.name}
          </span>
        )}

        <span
          style={{
            fontSize: "11mm",
            lineHeight: 1.05,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {member.name}
        </span>

        <Belt rank={member.rank} size="lg" />
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={qrDataUrl}
        alt={`Scan code for ${member.name}`}
        data-testid={`qr-${member.id}`}
        style={{
          width: `${QR_MM}mm`,
          height: `${QR_MM}mm`,
          flexShrink: 0,
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}

export default MemberCardSheet;
