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
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
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

type CoachClass = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  location: string | null;
  attendedCount: number;
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
  | "network";

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
  request_failed: { label: "Didn't record", hint: "Hold the card again — or use the register.", tone: "bad" },
  network: { label: "Didn't reach MatFlow", hint: "Check signal and hold the card again.", tone: "bad" },
};

/** A member is in the register after these — recorded now, or already there. */
const IN_REGISTER: ReadonlySet<ScanStatus> = new Set(["success", "duplicate"]);

/**
 * Statuses that are neither "in" nor "need attention": a row still in flight,
 * or one the coach removed. Neither exists on this screen yet — the pending
 * row and Remove are later work — but the counting rule must name them now, or
 * the header would flag every in-flight card as needing attention the day they
 * land.
 */
const NOT_COUNTED: ReadonlySet<string> = new Set(["pending", "removed"]);

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
  request_failed: () => "That card didn't record. Hold the card again.",
  network: () => "That card didn't send. Check signal and hold the card again.",
};

/** Consecutive `detect()` rejections before the camera is declared dead. */
const DEAD_DETECTOR_MESSAGE = "This phone couldn't read the camera image — take today's register by hand.";

/**
 * Pure loader: returns the classes or a failure, and touches no React state.
 *
 * Keeping the fetch separate from the state write is what lets the mount effect
 * apply the result inside a callback (and drop it entirely if the component has
 * unmounted) rather than calling a state-setting function directly in the
 * effect body.
 */
type LoadResult = { ok: true; classes: CoachClass[] } | { ok: false };

async function fetchTodaysClasses(): Promise<LoadResult> {
  try {
    const res = await fetch("/api/coach/today");
    if (!res.ok) return { ok: false };
    const data = await res.json();
    // An error object rendered as an empty list is the exact defect that
    // crashed Mark Attendance; a non-array is a failure, not "no classes".
    if (!Array.isArray(data)) return { ok: false };
    return { ok: true, classes: data as CoachClass[] };
  } catch {
    return { ok: false };
  }
}

type CameraState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

export default function CardScanner() {
  const [classes, setClasses] = useState<CoachClass[] | null>(null);
  const [classesError, setClassesError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraState>({ kind: "idle" });
  const [rows, setRows] = useState<ScanRow[]>([]);
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
  /** Mirrors `selectedId` for the detect loop, which closes over its first render. */
  const selectedRef = useRef<string | null>(null);
  /** Bumped on every Start and every Stop — design note 5. */
  const scanGenRef = useRef(0);

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const applyResult = useCallback((r: LoadResult) => {
    if (r.ok) {
      setClasses(r.classes);
      setClassesError(false);
      return;
    }
    // A failed load is an error state, never an empty list: "no classes today"
    // and "we could not ask" look identical to a coach and mean opposite things.
    setClasses(null);
    setClassesError(true);
  }, []);

  // Once on mount. The `cancelled` guard is not ceremony: without it a coach
  // navigating away mid-request sets state on an unmounted component.
  useEffect(() => {
    let cancelled = false;
    void fetchTodaysClasses().then((r) => {
      if (!cancelled) applyResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResult]);

  const retryClasses = useCallback(async () => {
    applyResult(await fetchTodaysClasses());
  }, [applyResult]);

  const submitToken = useCallback(async (token: string) => {
    const classInstanceId = selectedRef.current;
    if (!classInstanceId) return;
    // Captured now: a late response must un-see from the Set this token was
    // added to, never from a later session's fresh one.
    const seen = seenRef.current;

    const push = (status: ScanStatus, memberName?: string) => {
      setRows((prev) => [{ token, status, memberName, at: Date.now() }, ...prev]);
      setAnnouncement((prev) => ({ text: ANNOUNCE[status](memberName), seq: prev.seq + 1 }));
      // The long buzz: the coach's eyes are on the stack, and this is the one
      // signal that says "look at the phone". Absent on iOS, inert on desktop.
      if (!IN_REGISTER.has(status)) navigator.vibrate?.(200);
    };

    try {
      const res = await fetch("/api/checkin/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classInstanceId, tokens: [token] }),
        // A request that never settles would otherwise push no row, never
        // un-see the token, and leave the card silently dead for the session
        // — after the short buzz had told the coach it was read.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // A failed request must never leave the card looking recorded. It is
        // also un-seen again, so the coach can simply hold it again.
        seen.delete(token);
        push("request_failed");
        return;
      }
      const data = await res.json();
      const result = Array.isArray(data?.results) ? data.results[0] : null;
      if (!result || typeof result.status !== "string" || !(result.status in STATUS_COPY)) {
        seen.delete(token);
        push("request_failed");
        return;
      }
      push(result.status as ScanStatus, result.memberName);
    } catch {
      seen.delete(token);
      push("network");
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
    // read. An absent method is a polyfill or a future engine — unknown is not
    // a refusal, and the failure counter in the loop is the backstop.
    try {
      const formats = await Ctor.getSupportedFormats?.();
      if (stale()) return;
      if (Array.isArray(formats) && !formats.includes("qr_code")) {
        setCamera({ kind: "unsupported" });
        return;
      }
    } catch {
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
  const last = rows[0] ?? null;
  const selected = classes?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scan cards"
        description="Pick the session, then hold your phone about 20 cm over each card in turn. Only today's classes are listed, so a scan can never land on the wrong day."
      />

      {/* Always mounted, so the first scan of a stack is announced. A region
          inserted together with its first child is never read out. */}
      <p className="sr-only" role="status" aria-live="polite">
        <span key={announcement.seq}>{announcement.text}</span>
      </p>

      {classesError && (
        <ErrorState message="Couldn't load today's classes — tap to retry" onRetry={() => { void retryClasses(); }} />
      )}

      {!classesError && classes === null && <p className="text-sm text-tx-3">Loading today&rsquo;s classes…</p>}

      {!classesError && classes?.length === 0 && (
        <p className="text-sm text-tx-3">
          Nothing scheduled today, so there is no session to scan into.
        </p>
      )}

      {!classesError && classes && classes.length > 0 && (
        <div className="space-y-2">
          <span id="scan-session-label" className="block text-sm font-medium text-tx-2">Session</span>
          {/* Which class the next 25 cards are written into must not be
              conveyed by colour alone: `aria-pressed` carries it. */}
          <div role="group" aria-labelledby="scan-session-label" className="flex flex-wrap gap-x-2 gap-y-3">
            {classes.map((c) => (
              <Button
                key={c.id}
                variant={c.id === selectedId ? "primary" : "secondary"}
                aria-pressed={c.id === selectedId}
                onClick={() => {
                  setSelectedId(c.id);
                  // A new session starts a new stack: previously scanned cards
                  // must be scannable again, into the class now selected.
                  seenRef.current = new Set();
                  setRows([]);
                }}
              >
                {c.startTime} · {c.name}
                {c.location ? ` · ${c.location}` : ""}
              </Button>
            ))}
          </div>
        </div>
      )}

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
                  Last: {last.memberName ?? "card not recognised"} — {STATUS_COPY[last.status].label.toLowerCase()}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              {/* Always on screen, not only in the failure box: three hints
                  say "use the register", and this is the register. A new tab,
                  because this screen's list is component state until it is
                  lifted — navigating away would destroy the stack's record. */}
              <Link
                href="/dashboard/coach"
                target="_blank"
                rel="noopener"
                className="text-sm font-medium text-tx-2 underline"
              >
                Open today&rsquo;s register
              </Link>
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
                You can take the register by hand in the meantime — nothing is lost.
              </p>
              <Link
                href="/dashboard/coach"
                className="mt-2 inline-block text-sm font-medium text-tx-1 underline"
              >
                Open today&rsquo;s register
              </Link>
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
                    <p className="text-sm font-medium text-tx-1">{r.memberName ?? "Unknown card"}</p>
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
