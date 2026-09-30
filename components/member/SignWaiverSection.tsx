"use client";

/**
 * SignWaiverSection — the member's own liability-waiver signing flow.
 *
 * Why this exists as its own component:
 *   The signing UI used to live ONLY as step 7 of the first-run wizard in
 *   app/member/home/page.tsx, and that wizard is gated on
 *   `Member.onboardingCompleted`. Once that flag flips true the wizard never
 *   reopens — so a member who finished onboarding without a signature (or whose
 *   signature POST failed after the flag was set) had NO way to sign, ever.
 *   Meanwhile the "Sign your waiver" system action (lib/member-actions.ts) sent
 *   them to /member/profile, which had no waiver UI at all. Two dead ends
 *   stacked on each other.
 *
 * It is deliberately the SAME flow as the wizard's step 7 — read, tick, type
 * your name, draw the signature — and posts to the same session-authenticated,
 * rate-limited, CSRF-guarded POST /api/waiver/sign. No new API surface.
 *
 * The parent/guardian equivalent for a child lives in KidPhotosAndWaiver.tsx
 * and posts to /api/waiver/sign-for-child; the two are intentionally separate
 * because the signer and the subject differ.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import SignaturePad, { type SignaturePadHandle } from "@/components/ui/SignaturePad";
import { describeSaveFailure } from "@/lib/save-failure";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useEmergencyContactGate, EmergencyContactFieldset, type EmergencyContact } from "@/components/member/EmergencyContactFields";

export type { EmergencyContact };

// No client-side fallback text: /api/waiver always answers with the text the
// server records (the club's, or its default). A local fallback shown while
// loading was not what got recorded (end-user review, 30 Sep 2026).

export default function SignWaiverSection({
  primaryColor,
  defaultName = "",
  emergencyContact,
  onSigned,
}: {
  primaryColor: string;
  /** Pre-fills the typed-signature field with the member's own name. */
  defaultName?: string;
  /**
   * The member's saved emergency contact. POST /api/waiver/sign refuses when
   * any of the three is missing, so a member who skipped the welcome wizard
   * used to hit "…required before signing" with no field to fill (F-21). When
   * the saved trio is incomplete this form asks for it and saves it first,
   * through the same PATCH /api/member/me the wizard uses.
   */
  emergencyContact?: EmergencyContact;
  /** Fired after a successful sign so the parent can refresh its state. */
  onSigned?: () => void;
}) {
  const contact = useEmergencyContactGate(emergencyContact);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  // True only once the club's own waiver is on screen: until then a
  // placeholder title and an empty body showed, and signing was allowed
  // (end-user review, 30 Sep 2026).
  const [loaded, setLoaded] = useState(false);

  const [agreed, setAgreed] = useState(false);
  const [signerName, setSignerName] = useState(defaultName);
  const [signatureEmpty, setSignatureEmpty] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);

  const padRef = useRef<SignaturePadHandle>(null);
  // One request id per distinct signature: a retry after a lost response
  // reuses it and the server returns the waiver already signed (lane 7).
  const attemptRef = useRef<{ key: string; sig: string } | null>(null);

  const loadWaiver = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/waiver");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { title?: string; content?: string };
      if (typeof data?.title !== "string" || typeof data?.content !== "string") throw new Error("no waiver text");
      setTitle(data.title);
      setBody(data.content);
      setLoaded(true);
    } catch {
      // UI-RULES §7: an HTTP failure is an error state, never a silent empty one.
      setLoadError("Couldn't load your gym's waiver — tap retry.");
    }
  }, []);

  useEffect(() => { void loadWaiver(); }, [loadWaiver]);

  const canSubmit = loaded && agreed && signerName.trim().length > 0 && !signatureEmpty && contact.ready && !submitting;

  async function submit() {
    const signatureDataUrl = padRef.current?.getDataUrl();
    if (!signatureDataUrl) {
      setSubmitError("Please draw your signature before submitting.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const sig = JSON.stringify([signatureDataUrl, signerName.trim()]);
    const held = attemptRef.current;
    const requestId = held && held.sig === sig ? held.key : crypto.randomUUID();
    attemptRef.current = { key: requestId, sig };
    try {
      const contactError = await contact.save();
      if (contactError) {
        setSubmitError(contactError);
        return;
      }
      let res: Response;
      try {
        res = await fetch("/api/waiver/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signatureDataUrl, signerName: signerName.trim(), agreedTo: true, requestId, shownTitle: title, shownContent: body }),
        });
      } catch {
        setSubmitError(describeSaveFailure(0, null, "Sign waiver", { idempotent: true }).message);
        return;
      }
      if (!res.ok) {
        // The route's own sentence where it gave one (rate limits and
        // signature-format rejections both explain themselves usefully).
        const errBody = await res.json().catch(() => null);
        setSubmitError(describeSaveFailure(res.status, errBody, "Sign waiver", { idempotent: true }).message);
        // The club changed its waiver while this one was open: show the new
        // text and ask for agreement again.
        if ((errBody as { reason?: string } | null)?.reason === "waiver_changed") {
          setAgreed(false);
          setLoaded(false);
          void loadWaiver();
        }
        return;
      }
      setDone(true);
      onSigned?.();
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div
        className="rounded-2xl border p-5 text-center"
        style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
      >
        <p className="text-sm font-semibold" style={{ color: "var(--member-text)" }}>
          Waiver signed
        </p>
        <p className="text-xs mt-1" style={{ color: "var(--member-text-muted)" }}>
          Thanks — your gym has it on file. You&apos;re clear to train.
        </p>
      </div>
    );
  }

  return (
    <section
      id="sign-waiver"
      aria-labelledby="sign-waiver-heading"
      className="rounded-2xl border p-5 space-y-4 scroll-mt-24"
      style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
    >
      <div>
        <h2 id="sign-waiver-heading" className="text-base font-bold" style={{ color: "var(--member-text)" }}>
          Sign your waiver
        </h2>
        <p className="text-xs mt-1" style={{ color: "var(--member-text-muted)" }}>
          Your gym needs this on file before your next class. Takes about a minute.
        </p>
      </div>

      {loadError && (
        <div role="alert" className="flex items-center justify-between gap-3">
          <p className="text-xs" style={{ color: "var(--member-warning)" }}>{loadError}</p>
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={() => void loadWaiver()}
            className="shrink-0 underline underline-offset-4"
            style={{ color: "var(--member-text)" }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Tap-to-read-in-full. A liability waiver read through a 208px letterbox
          is both poor UX and weak evidence it was actually read, so the preview
          opens a full-height Sheet with the whole document. Sheet rather than
          Dialog because its own contract says scrolling content belongs in a
          Sheet; `navClearance="member-nav"` keeps it clear of the fixed tab
          bar. The checkbox and signature deliberately stay on the page — the
          sheet is for READING, so closing it never discards work. */}
      <div
        aria-hidden="true"
        className="rounded-2xl border p-4 h-52 overflow-hidden text-xs leading-relaxed space-y-2 relative"
        style={{ background: "var(--member-elevated)", borderColor: "var(--member-border)", color: "var(--member-text-muted)" }}
      >
        {loaded ? (
          <>
            <p className="font-semibold" style={{ color: "var(--member-text)" }}>{title}</p>
            {body.split("\n\n").map((para, i) => <p key={i}>{para}</p>)}
          </>
        ) : (
          <p>{loadError ? "" : "Loading your gym's waiver…"}</p>
        )}
        {/* Fade so the truncation reads as "there is more", rather than a
            document that simply stops mid-sentence. */}
        <span
          className="absolute inset-x-0 bottom-0 h-16"
          style={{ background: "linear-gradient(to bottom, transparent, var(--member-elevated) 80%)" }}
        />
      </div>

      {/* The preview above is decorative — aria-hidden, non-interactive — and
          THIS is the control. A single labelled button is unambiguous and
          keyboard-native, where a tappable 208px card is neither; it also keeps
          the raw-<button> ratchet moving down rather than up (UI-RULES §11).
          The full text lives in the Sheet, which is where it is actually
          readable. */}
      <Button
        type="button"
        variant="secondary"
        size="mobile"
        onClick={() => setReaderOpen(true)}
        disabled={!loaded}
        className="w-full"
      >
        <Maximize2 className="w-4 h-4" /> Read the full waiver
      </Button>

      <Sheet
        open={readerOpen}
        onClose={() => setReaderOpen(false)}
        title={title}
        description="Read in full before signing."
        navClearance="member-nav"
      >
        <div className="space-y-3 text-sm leading-relaxed">
          {body.split("\n\n").map((para, i) => <p key={i}>{para}</p>)}
        </div>
      </Sheet>

      {/* Real checkbox input, visually hidden, so the whole label is tappable
          and screen-reader complete — matches the wizard's audit-D2 fix. */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="sr-only"
        />
        <div
          aria-hidden="true"
          className="w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5 border transition-all"
          style={{
            background: agreed ? primaryColor : "transparent",
            borderColor: agreed ? primaryColor : "var(--member-border)",
          }}
        >
          {agreed && (
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" style={{ color: "var(--tx-on-accent)" }}>
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <span className="text-sm leading-tight" style={{ color: "var(--member-text-muted)" }}>
          I have read and agree to the liability waiver above
        </span>
      </label>

      <EmergencyContactFieldset gate={contact} idPrefix="waiver" />

      <div>
        <label htmlFor="waiver-signer-name" className="text-xs font-medium block mb-1.5" style={{ color: "var(--member-text-muted)" }}>
          Type your full name to sign *
        </label>
        <input
          id="waiver-signer-name"
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          placeholder="Your full name"
          className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
          style={{ background: "var(--member-elevated)", borderColor: "var(--member-border)", color: "var(--member-text)" }}
        />
      </div>

      <div>
        <span className="text-xs font-medium block mb-1.5" style={{ color: "var(--member-text-muted)" }}>
          Draw your signature *
        </span>
        <SignaturePad ref={padRef} onChange={(empty) => setSignatureEmpty(empty)} height={160} />
      </div>

      {submitError && (
        <p role="alert" className="text-xs" style={{ color: "var(--member-danger)" }}>
          {submitError}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: primaryColor, color: "var(--tx-on-accent)" }}
      >
        {submitting ? "Saving…" : "Sign waiver"}
      </button>
    </section>
  );
}
