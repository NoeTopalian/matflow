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
import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Belt, isUngraded, type BeltRank } from "@/components/ui/Belt";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { initials } from "@/lib/initials";

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

  const printable = members.filter((m) => qr.codes[m.id]);
  const excluded = members.filter((m) => qr.failedIds.includes(m.id));
  const withPhoto = printable.filter((m) => !!m.photoUrl);
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

        @media print {
          .card-sheet-chrome { display: none !important; }
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold" style={{ color: "var(--tx-1)" }}>
              Member cards
            </h1>
            <p className="text-sm" style={{ color: "var(--tx-2)" }}>
              {printable.length} {printable.length === 1 ? "card" : "cards"} across{" "}
              {sheets.length} A4 {sheets.length === 1 ? "sheet" : "sheets"}, two per sheet. Cut along
              the dashed line.
            </p>
          </div>
          <Button onClick={() => window.print()} disabled={printable.length === 0}>
            <Printer aria-hidden="true" />
            Print
          </Button>
        </div>

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
            />
          ) : (
            // The odd card out. An empty half-sheet is printed blank rather
            // than filled, so the cut line stays where the guillotine expects.
            <div className="card-sheet-card" aria-hidden="true" />
          )}
        </div>
      ))}
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
}: {
  club: PrintCardClub;
  member: PrintCardMember;
  qrDataUrl: string;
  photoFailed: boolean;
  onPhotoError: (id: string) => void;
  logoFailed: boolean;
  onLogoError: () => void;
}) {
  // No `?? member.photoUrl` fallback: toBlobProxyUrl returns non-blob input
  // unchanged and is nullish only when its input already was, so the arm could
  // never fire and only implied a fallback that does not exist.
  const photoSrc = photoFailed ? null : toBlobProxyUrl(member.photoUrl);
  const logoSrc = logoFailed ? null : toBlobProxyUrl(club.logoUrl);

  return (
    <div className="card-sheet-card" data-testid={`card-${member.id}`}>
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
