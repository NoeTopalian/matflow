"use client";

// Coach card scanner — hold the phone over a stack of printed member ID cards
// and the class registers itself.
//
// DESIGN NOTES THAT ARE EASY TO UNDO BY ACCIDENT
// ----------------------------------------------
// 1. ONE CARD PER REQUEST. The endpoint accepts an array, but this client
//    sends exactly one token at a time, so a dropped connection costs the card
//    in flight rather than a whole class's register. Batching the queue into a
//    single request would be faster and strictly worse.
//
// 2. EVERY OUTCOME IS RENDERED, AND COUNTED. A scan that did not record must
//    never be invisible behind a success tally — a coach clearing a stack has
//    no other way to know. The header counts what the coach actually held:
//    "scanned in" is every card whose member is in the register (recorded now,
//    or already in), "need attention" is everything else. Neither number is
//    ever mutated by hand; both are derived from the rows.
//
// 3. A CAMERA DECODES THE SAME QR MANY TIMES A SECOND. Without the `seen` set,
//    holding one card still would fire dozens of identical requests. The
//    de-duplication is by exact token string, which is sound only because
//    lib/card-token.ts decodes canonically (one card is exactly one string).
//    The short buzz fires on the newly-seen branch, after that guard — put it
//    before the guard and a held card buzzes four times a second.
//
// 4. "NOT SUPPORTED" AND "PERMISSION DENIED" ARE DIFFERENT PROBLEMS with
//    different remedies, and collapsing them into "camera unavailable" tells a
//    coach nothing they can act on. Both fall back to today's register rather
//    than stalling, because scanning must degrade to slower, never to
//    impossible. A THIRD problem is a detector that exists and never decodes
//    (Chrome on Windows/Linux desktop; an Android without the Play Services
//    barcode module): the constructor is present, `detect()` rejects on every
//    frame, and without the failure counter below the screen would say
//    "running" over a camera under which nothing ever happens.
//
// 5. EVERY CAMERA START HAS A GENERATION. `stopCamera()` clears the interval,
//    but a tick already suspended at `await detect()` still resumes — and a
//    detect from a PREVIOUS start can reject after the next start has begun.
//    The stamp is captured once per start as a closure constant and checked
//    after every await, so a stale closure can never submit a card, count a
//    failure, or stop the live camera.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { nextDetectorState } from "@/lib/scan-detector";

/**
 * Minimal shape of the Barcode Detection API. TypeScript ships no lib types for
 * it, and it is absent on Firefox and on EVERY WebKit browser — which means
 * every browser on an iPhone, Chrome-for-iOS included, since they are all
 * WebKit — which is exactly why the unsupported path below is a first-class
 * state rather than an afterthought. Chrome on Android and Chrome on macOS
 * have it; Chrome on Windows/Linux desktop exposes the constructor without a
 * barcode backend, which is what the capability check guards.
 */
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  /** Static on the interface object; absent on polyfills, so treated as unknown. */
  getSupportedFormats?: () => Promise<string[]>;
};

type WakeLockSentinelLike = { release(): Promise<void> };
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
};

/** The session the hub selected for us. Switching sessions remounts this component. */
export type ScannerInstance = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  location: string | null;
};

type ScanStatus =
  | "success"
  | "duplicate"
  | "revoked"
  | "invalid"
  | "expired"
  | "wrong_tenant"
  | "member_not_found"
  | "class_not_found"
  | "class_cancelled"
  | "error"
  | "request_failed"
  | "network"
  // In flight — pushed at decode, replaced in place by the outcome.
  | "pending"
  // Derived from the HTTP response, never from the body (A4-iv).
  | "signed_out"
  | "not_allowed"
  | "class_gone"
  | "rate_limited"
  | "server_down";

type ScanRow = {
  /** The token, used only as a React key and for de-duplication. Never shown. */
  token: string;
  status: ScanStatus;
  memberName?: string;
  at: number;
};

/**
 * What a coach is told for each outcome, in plain language. Deliberately says
 * what to DO where there is something to do — "invalid" and "revoked" look
 * identical to someone holding a card that will not scan, and the difference
 * decides whether they reprint it or check the member's account.
 *
 * Two kinds of failure hint on purpose. `error`, `class_not_found` and
 * `class_cancelled` arrive as a 200 body, so the token is NOT un-seen and
 * holding the card again does nothing: "try again" would be a silent dead end,
 * so those say "use the register". `request_failed` and `network` un-see the
 * token, so holding the card again genuinely retries.
 */
const STATUS_COPY: Record<ScanStatus, { label: string; hint?: string; tone: "ok" | "warn" | "bad" }> = {
  success: { label: "Checked in", tone: "ok" },
  duplicate: { label: "Already in", hint: "Scanned twice — no harm done", tone: "ok" },
  revoked: { label: "Card cancelled", hint: "This card was replaced. Print the new one.", tone: "warn" },
  expired: { label: "Card expired", hint: "Print a replacement.", tone: "warn" },
  invalid: { label: "Not a MatFlow card", hint: "Check you scanned the QR, not another code.", tone: "bad" },
  wrong_tenant: { label: "Another club's card", tone: "bad" },
  member_not_found: { label: "Member not found", hint: "They may have been removed.", tone: "bad" },
  class_not_found: { label: "Class not found", hint: "Use the register for this one — rescanning won't retry it.", tone: "bad" },
  class_cancelled: { label: "Class was cancelled", hint: "Use the register for this one — rescanning won't retry it.", tone: "bad" },
  error: { label: "Didn't record", hint: "Use the register for this one — rescanning won't retry it.", tone: "bad" },
  request_failed: { label: "Didn't record", hint: "Hold the card again once — if it fails twice, use the register.", tone: "bad" },
  network: { label: "Didn't reach MatFlow", hint: "Check signal and hold the card again once — if it fails twice, use the register.", tone: "bad" },
  pending: { label: "Sending…", tone: "ok" },
  // Kept seen, so the remedy is the register, never "hold it again". A
  // captive-portal page on venue wifi lands here too, hence the clause.
  signed_out: { label: "Signed out", hint: "Sign in again (or the venue wifi wants one). Use the register for this one — rescanning won't retry it.", tone: "bad" },
  // A 403 is either the instructor narrowing or the same-origin check, and
  // only one of those means "not your class" — so the sentence is neutral.
  not_allowed: { label: "MatFlow refused this scan", hint: "Use the register for this one.", tone: "bad" },
  class_gone: { label: "Class not found", hint: "Pick another session, or use the register.", tone: "bad" },
  // NOT un-seen: holding the card again is exactly what re-trips the limiter.
  rate_limited: { label: "Too many at once", hint: "Wait a moment. Use the register for this one — rescanning won't retry it.", tone: "warn" },
  server_down: { label: "MatFlow couldn't record this", hint: "Hold the card again once — if it fails twice, use the register.", tone: "bad" },
};

/**
 * The row's primary line when no member name came back. "Unknown card" is a
 * claim about the card, and for most failures nothing is known about the card
 * — only that the request did not succeed.
 */
const NO_NAME: Record<ScanStatus, string> = {
  success: "Unknown card",
  duplicate: "Unknown card",
  revoked: "Unknown card",
  invalid: "Unknown card",
  wrong_tenant: "Unknown card",
  expired: "Card expired — ask the member their name",
  member_not_found: "Card not on file",
  class_not_found: "Card not sent",
  class_cancelled: "Card not sent",
  error: "Card not sent",
  request_failed: "Card not sent",
  network: "Card not sent",
  pending: "Reading…",
  signed_out: "Card not sent",
  not_allowed: "Card not sent",
  class_gone: "Card not sent",
  rate_limited: "Card not sent",
  server_down: "Card not sent",
};

/**
 * Failures after which the coach can hold the card again — ONCE per token per
 * stack (`retriedRef`). Un-seeing on settle while the card is still under the
 * lens means the loop re-submits it 250 ms later, so without the bound a card
 * held through a Neon blip is resubmitted at 4 Hz, one row per attempt, and
 * spends the 240-per-5-minute limiter inside a minute. Every other failure
 * keeps the token seen, because for those the copy sends the coach elsewhere.
 */
const RETRYABLE_BY_HOLDING: ReadonlySet<ScanStatus> = new Set(["request_failed", "network", "server_down"]);

/**
 * The statuses the route can actually put in a 200 body. The response-derived
 * statuses are never accepted from a body: a body claiming "pending" would
 * otherwise settle a row that stays pending for ever.
 */
const SERVER_STATUSES: ReadonlySet<string> = new Set([
  "success", "duplicate", "revoked", "invalid", "expired", "wrong_tenant",
  "member_not_found", "class_not_found", "class_cancelled", "error",
]);

/** A member is in the register after these — recorded now, or already there. */
const IN_REGISTER: ReadonlySet<ScanStatus> = new Set(["success", "duplicate"]);

/**
 * Statuses that are neither "in" nor "need attention": a row still in flight.
 * A row the coach has removed joins this set when Remove lands. Without it the
 * header would flag every card as needing attention for the 200–500 ms it
 * spends in flight.
 */
const NOT_COUNTED: ReadonlySet<ScanStatus> = new Set(["pending"]);

/**
 * What the screen-reader region says when a row settles. Name first, because
 * the name is what the coach is checking against the card in their hand; the
 * verdict word matches the row's label or a shorter true synonym of it. Spoken
 * sentences are shortened on purpose. Never a sentence about a control that is
 * not on the screen.
 */
const ANNOUNCE: Record<ScanStatus, (name?: string) => string> = {
  success: (n) => `${n ?? "That card"}, checked in.`,
  duplicate: (n) => `${n ?? "That card"}, already in.`,
  revoked: (n) => `${n ?? "That card"}, card cancelled. Print the new one.`,
  expired: () => "Card expired. Ask the member their name.",
  invalid: () => "Not a MatFlow card.",
  wrong_tenant: () => "Another club's card.",
  member_not_found: () => "Member not found.",
  class_not_found: (n) => `${n ? `${n}'s card` : "That card"} didn't record. Use the register for this one.`,
  class_cancelled: (n) => `${n ? `${n}'s card` : "That card"} didn't record. Use the register for this one.`,
  error: (n) => `${n ? `${n}'s card` : "That card"} didn't record. Use the register for this one.`,
  request_failed: () => "That card didn't record. Hold the card again once.",
  network: () => "That card didn't send. Check signal and hold the card again once.",
  // Never announced (noise at 4 Hz); the outcome that replaces it is.
  pending: () => "",
  signed_out: () => "Signed out. Sign in again, then use the register for this one.",
  not_allowed: () => "MatFlow refused this scan. Use the register for this one.",
  class_gone: () => "Class not found. Pick another session.",
  rate_limited: () => "Too many at once. Use the register for this one.",
  server_down: () => "That card didn't record. Hold the card again once.",
};

/** Consecutive `detect()` rejections before the camera is declared dead. */
const DEAD_DETECTOR_MESSAGE = "This phone couldn't read the camera image — tick names by hand instead.";

type CameraState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

export default function CardScanner({ instance }: { instance: ScannerInstance }) {
  const [camera, setCamera] = useState<CameraState>({ kind: "idle" });
  const [rows, setRows] = useState<ScanRow[]>([]);
  /**
   * The most recently SETTLED outcome, in settle order — not `rows[0]`, which
   * is the most recently SCANNED row: a card that rides the 10 s timeout
   * settles after five later cards, and the line above the fold must name it.
   */
  const [lastSettled, setLastSettled] = useState<{ status: ScanStatus; memberName?: string } | null>(null);
  /**
   * The one sentence the status region speaks. `seq` is the React key of the
   * rendered text: setting an identical string twice is a state bail-out with
   * no DOM mutation, so two "Not a MatFlow card." rows in a row would be one
   * announcement without it.
   */
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>({ text: "", seq: 0 });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  /** Tokens already submitted this session — see design note 3. */
  const seenRef = useRef<Set<string>>(new Set());
  /** Tokens already un-seen once this stack; a second failure keeps them seen. */
  const retriedRef = useRef<Set<string>>(new Set());
  /**
   * Mirrors the session for the detect loop, which closes over its first
   * render. The hub remounts this component per session (`key={instance.id}`),
   * so a switch also resets the seen set, the rows and the camera — the
   * guarantees the old in-component picker gave, without the picker.
   */
  const selectedRef = useRef<string | null>(instance.id);
  /** Bumped on every Start and every Stop — design note 5. */
  const scanGenRef = useRef(0);

  useEffect(() => {
    selectedRef.current = instance.id;
  }, [instance.id]);

  const submitToken = useCallback(async (token: string) => {
    const classInstanceId = selectedRef.current;
    if (!classInstanceId) return;
    // Captured now: a late response must un-see from the Set this token was
    // added to, never from a later session's fresh one.
    const seen = seenRef.current;
    const retried = retriedRef.current;
    const at = Date.now();

    // The row exists from the moment the card is read, so a scan in flight is
    // visibly different from a card that never decoded — and the list is in
    // scan order, not response order.
    setRows((prev) => [{ token, status: "pending", at }, ...prev]);

    // The pending row becomes the outcome, in place.
    const settle = (status: ScanStatus, memberName?: string) => {
      setRows((prev) => {
        const i = prev.findIndex((r) => r.token === token && r.at === at);
        // No row: a session switch cleared the list while this was in flight.
        // The scan still recorded, into the class it was sent to — Stop cannot
        // recall a request already on the wire — so the outcome is shown,
        // never dropped. Labelling the row with its own session is later work.
        if (i === -1) return [{ token, status, memberName, at }, ...prev];
        const next = prev.slice();
        next[i] = { ...prev[i], status, memberName };
        return next;
      });
      setLastSettled({ status, memberName });
      setAnnouncement((prev) => ({ text: ANNOUNCE[status](memberName), seq: prev.seq + 1 }));
      // The long buzz: the coach's eyes are on the stack, and this is the one
      // signal that says "look at the phone". Absent on iOS, inert on desktop.
      if (!IN_REGISTER.has(status)) navigator.vibrate?.(200);
      if (RETRYABLE_BY_HOLDING.has(status) && !retried.has(token)) {
        retried.add(token);
        seen.delete(token);
      }
    };

    try {
      const res = await fetch("/api/checkin/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classInstanceId, tokens: [token] }),
        // Never follow a redirect: the proxy answers an expired session with a
        // 307 to /login, and following it hands back the login PAGE as a 200,
        // which used to read as "check your signal".
        redirect: "manual",
        // A request that never settles would otherwise leave the row pending
        // and the token seen for the rest of the session.
        signal: AbortSignal.timeout(10_000),
      });
      if (res.type === "opaqueredirect" || res.status === 0) {
        settle("signed_out");
        return;
      }
      if (!res.ok) {
        settle(
          res.status === 401
            ? "signed_out"
            : res.status === 403
              ? "not_allowed"
              : res.status === 404
                ? "class_gone"
                : res.status === 409
                  ? "class_cancelled"
                  : res.status === 429
                    ? "rate_limited"
                    : res.status >= 500
                      ? "server_down"
                      : "request_failed",
        );
        return;
      }
      // A 200 that is not JSON is a page, not an answer.
      if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
        settle("signed_out");
        return;
      }
      // A body that will not parse is a server fault, not a signal problem.
      const data = await res.json().catch(() => null);
      const result = data && Array.isArray(data.results) ? data.results[0] : null;
      if (!result || typeof result.status !== "string" || !SERVER_STATUSES.has(result.status)) {
        settle("request_failed");
        return;
      }
      settle(result.status as ScanStatus, result.memberName);
    } catch {
      settle("network");
    }
  }, []);

  const stopCamera = useCallback(() => {
    // Any tick or start still suspended at an await belongs to a generation
    // that is now over, and will find out when it resumes.
    scanGenRef.current += 1;
    if (loopRef.current !== null) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock) void lock.release().catch(() => {});
  }, []);

  const startCamera = useCallback(async () => {
    // First, before any await: the Start button is disabled the moment this
    // commits. An await ahead of it would leave the button live for a second
    // tap — two getUserMedia grants, the first stream never stopped — on
    // exactly the slow platforms the capability check below exists for.
    setCamera({ kind: "starting" });
    const gen = ++scanGenRef.current;
    const stale = () => gen !== scanGenRef.current;

    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Ctor) {
      setCamera({ kind: "unsupported" });
      return;
    }

    // Prove the detector before claiming to run. A constructor that exists is
    // not a decoder that works: ask the platform which formats it can actually
    // read. Only a NON-EMPTY list that lacks QR is a refusal. An absent method
    // is a polyfill or a future engine, and an EMPTY list is Chrome on Android
    // whose Play Services barcode module has not downloaded yet — and it is
    // constructing the detector and calling `detect()` that triggers that
    // download, so refusing here would turn a phone that warms up in seconds
    // into one that is refused for ever, with copy telling a Chrome-on-Android
    // coach that they need Chrome on Android. Unknown is not a refusal; the
    // failure counter in the loop is the backstop for a detector that never
    // decodes.
    try {
      const formats = await Ctor.getSupportedFormats?.();
      if (stale()) return;
      if (Array.isArray(formats) && formats.length > 0 && !formats.includes("qr_code")) {
        setCamera({ kind: "unsupported" });
        return;
      }
    } catch {
      if (stale()) return;
      setCamera({ kind: "unsupported" });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // `ideal` cannot throw OverconstrainedError; it degrades silently. At
        // Chrome's 640x480 default a 45 mm code is two or three pixels per
        // module at hand-held distance — decodes on a good frame, fails on a
        // shaky one, and looks exactly like a broken scanner.
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      if (stale()) return;
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCamera({ kind: "denied" });
      } else {
        setCamera({ kind: "failed", message: "Couldn't start the camera on this device." });
      }
      return;
    }
    if (stale()) {
      // Superseded while the grant was in flight: this start owns a stream
      // nothing else knows about, so it stops it itself.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setCamera({ kind: "failed", message: "Couldn't start the camera on this device." });
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay refusal is recoverable — the element is visible and the user
      // can tap it — so this is not a hard failure.
    }
    if (stale()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    let detector: BarcodeDetectorLike;
    try {
      detector = new Ctor({ formats: ["qr_code"] });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setCamera({ kind: "unsupported" });
      return;
    }
    setCamera({ kind: "running" });

    // Keep the screen awake while scanning: 25 cards is two or three minutes
    // with no touch input against a typical 30 s lock, and a locked phone is a
    // dead camera the UI cannot see. Awaited, then checked against the
    // generation before it is stored — a Stop landing mid-request would
    // otherwise find nothing to release and the sentinel would keep the phone
    // awake for ever. Unsupported browsers simply no-op.
    void (async () => {
      try {
        const lock = await (navigator as NavigatorWithWakeLock).wakeLock?.request("screen");
        if (!lock) return;
        if (stale()) {
          void lock.release().catch(() => {});
          return;
        }
        wakeLockRef.current = lock;
      } catch {
        /* the demo script says: if the screen dims, Stop then Start */
      }
    })();

    // Per start, so a Stop→Start begins at zero and a rejection landing from
    // a previous start's in-flight detect mutates a dead closure.
    let consecutiveFailures = 0;

    loopRef.current = window.setInterval(async () => {
      const el = videoRef.current;
      if (!el || el.readyState < 2) return;
      let codes: DetectedBarcode[];
      try {
        codes = await detector.detect(el);
      } catch {
        // A stale closure must not touch the live refs: `stopCamera()` reads
        // them, and by now they may belong to the next start.
        if (stale()) return;
        const next = nextDetectorState(consecutiveFailures);
        consecutiveFailures = next.failures;
        if (next.kind === "dead") {
          stopCamera();
          setCamera({ kind: "failed", message: DEAD_DETECTOR_MESSAGE });
        }
        return;
      }
      if (stale()) return;
      consecutiveFailures = 0;
      for (const code of codes) {
        const token = code.rawValue?.trim();
        if (!token || seenRef.current.has(token)) continue;
        seenRef.current.add(token);
        // The short buzz — "read" — on the newly-seen branch only (note 3).
        navigator.vibrate?.(30);
        void submitToken(token);
      }
    }, 250);
  }, [submitToken, stopCamera]);

  useEffect(() => stopCamera, [stopCamera]);

  const scannedIn = rows.filter((r) => IN_REGISTER.has(r.status)).length;
  const needsAttention = rows.filter((r) => !IN_REGISTER.has(r.status) && !NOT_COUNTED.has(r.status)).length;
  const last = lastSettled;
  const selected = instance;

  return (
    <div className="space-y-6">
      <p className="text-sm text-tx-3">
        Hold your phone about 20 cm over each card in turn. Every scan goes into the session selected above.
      </p>

      {/* Always mounted, so the first scan of a stack is announced. A region
          inserted together with its first child is never read out. */}
      <p className="sr-only" role="status" aria-live="polite">
        <span key={announcement.seq}>{announcement.text}</span>
      </p>

      {selected && (
        <div className="rounded-lg border border-bd-default bg-sf-1 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-tx-1">
                {selected.name} · {selected.startTime}–{selected.endTime}
              </p>
              <p className="text-sm text-tx-3">
                {scannedIn} scanned in
                {needsAttention > 0 ? ` · ${needsAttention} need attention` : ""}
              </p>
              {last && (
                // The confirmation lives inside the camera card, above the
                // fold on a phone, so the coach never scrolls to know the
                // card in their hand went in.
                <p className="text-sm text-tx-2">
                  Last: {last.memberName ?? NO_NAME[last.status]} — {STATUS_COPY[last.status].label}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              {camera.kind === "starting" && (
                // The permission prompt can be left unanswered (the coach swipes
                // away mid-prompt) and getUserMedia never settles. Stop bumps
                // the generation, so the start that eventually resumes stops
                // the stream it acquired and touches nothing else.
                <Button
                  variant="secondary"
                  onClick={() => {
                    stopCamera();
                    setCamera({ kind: "idle" });
                  }}
                >
                  Cancel
                </Button>
              )}
              {camera.kind === "running" ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    stopCamera();
                    setCamera({ kind: "idle" });
                  }}
                >
                  Stop camera
                </Button>
              ) : (
                <Button loading={camera.kind === "starting"} onClick={() => void startCamera()}>
                  {camera.kind === "starting" ? "Starting…" : "Start camera"}
                </Button>
              )}
            </div>
          </div>

          {/* `aspect-video` sets the box height, so the element does not jump
              from its 300x150 intrinsic default when the stream arrives;
              `dvh` not `vh`, because mobile Chrome's `vh` is the large
              viewport. CSS never touches the decoded frame — `detect()` reads
              the track — so the preview is a centred subset of what is read:
              a card that looks centred is centred. */}
          <video
            ref={videoRef}
            className={
              camera.kind === "running"
                ? "mt-4 w-full max-w-md aspect-video max-h-[45dvh] rounded-[var(--r-md)] bg-sf-2 object-cover"
                : "hidden"
            }
            muted
            playsInline
          />

          {(camera.kind === "unsupported" || camera.kind === "denied" || camera.kind === "failed") && (
            // `role="alert"` is announced on insertion, unlike a polite live
            // region, which is why this block may mount with its content.
            <div role="alert" className="mt-4 rounded-lg border border-bd-default p-3">
              <h2 className="text-sm font-medium text-tx-1">
                {camera.kind === "unsupported" && "This browser can't scan QR codes"}
                {camera.kind === "denied" && "Camera access was blocked"}
                {camera.kind === "failed" && camera.message}
              </h2>
              <p className="mt-1 text-sm text-tx-3">
                {camera.kind === "unsupported" &&
                  "Scanning needs Chrome on an Android phone — iPhones can't scan QR codes in the browser yet. "}
                {camera.kind === "denied" &&
                  "Allow the camera for this site in your browser settings — or, if the camera never appears, in Android Settings → Apps → Chrome → Permissions — then start again. "}
                You can tick names instead — it is the other section of this screen — and nothing is lost.
              </p>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-tx-2">Scans</h2>
          {/* Strictly newest-first: the list mirrors the stack in the coach's
              hand, and no row moves after it renders. Attention is by
              emphasis, not order. */}
          <ul className="divide-y divide-[color:var(--bd-default)] rounded-lg border border-bd-default bg-sf-1">
            {rows.map((r) => {
              const copy = STATUS_COPY[r.status];
              const ink =
                copy.tone === "ok"
                  ? "var(--hue-success-ink)"
                  : copy.tone === "warn"
                    ? "var(--hue-warning-ink)"
                    : "var(--hue-danger-ink)";
              return (
                <li
                  key={`${r.token}-${r.at}`}
                  className="flex items-start justify-between gap-3 p-3"
                  style={copy.tone === "ok" ? undefined : { boxShadow: `inset 2px 0 0 ${ink}` }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-tx-1">{r.memberName ?? NO_NAME[r.status]}</p>
                    {copy.hint && <p className="text-sm text-tx-3">{copy.hint}</p>}
                  </div>
                  <span className="shrink-0 text-sm font-medium" style={{ color: ink }}>
                    {copy.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
