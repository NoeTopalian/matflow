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
// 2. EVERY OUTCOME IS RENDERED. A scan that did not record must never be
//    invisible behind a success tally — a coach clearing a stack has no other
//    way to know. The failure count is always on screen, not behind a toggle.
//
// 3. A CAMERA DECODES THE SAME QR MANY TIMES A SECOND. Without the `seen` set,
//    holding one card still would fire dozens of identical requests. The
//    de-duplication is by exact token string, which is sound only because
//    lib/card-token.ts decodes canonically (one card is exactly one string).
//
// 4. "NOT SUPPORTED" AND "PERMISSION DENIED" ARE DIFFERENT PROBLEMS with
//    different remedies, and collapsing them into "camera unavailable" tells a
//    coach nothing they can act on. Both fall back to the manual register
//    rather than stalling, because scanning must degrade to slower, never to
//    impossible.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";

/**
 * Minimal shape of the Barcode Detection API. TypeScript ships no lib types for
 * it, and it is absent on Firefox and on desktop Safari, which is exactly why
 * the unsupported path below is a first-class state rather than an afterthought.
 */
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

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
 */
const STATUS_COPY: Record<ScanStatus, { label: string; hint?: string; tone: "ok" | "warn" | "bad" }> = {
  success: { label: "Checked in", tone: "ok" },
  duplicate: { label: "Already in", hint: "Scanned twice — no harm done", tone: "ok" },
  revoked: { label: "Card cancelled", hint: "This card was replaced. Print the new one.", tone: "warn" },
  expired: { label: "Card expired", hint: "Print a replacement.", tone: "warn" },
  invalid: { label: "Not a MatFlow card", hint: "Check you scanned the QR, not another code.", tone: "bad" },
  wrong_tenant: { label: "Another club's card", tone: "bad" },
  member_not_found: { label: "Member not found", hint: "They may have been removed.", tone: "bad" },
  class_not_found: { label: "Class not found", tone: "bad" },
  class_cancelled: { label: "Class was cancelled", tone: "bad" },
  error: { label: "Didn't record", hint: "Try again, or use the register.", tone: "bad" },
  network: { label: "Didn't reach MatFlow", hint: "Check signal and scan again.", tone: "bad" },
};

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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  /** Tokens already submitted this session — see design note 3. */
  const seenRef = useRef<Set<string>>(new Set());
  /** Mirrors `selectedId` for the detect loop, which closes over its first render. */
  const selectedRef = useRef<string | null>(null);

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

    const push = (status: ScanStatus, memberName?: string) =>
      setRows((prev) => [{ token, status, memberName, at: Date.now() }, ...prev]);

    try {
      const res = await fetch("/api/checkin/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classInstanceId, tokens: [token] }),
      });
      if (!res.ok) {
        // A failed request must never leave the card looking recorded. It is
        // also un-seen again, so the coach can simply rescan it.
        seenRef.current.delete(token);
        push(res.status === 429 ? "error" : "error");
        return;
      }
      const data = await res.json();
      const result = Array.isArray(data?.results) ? data.results[0] : null;
      if (!result || typeof result.status !== "string") {
        seenRef.current.delete(token);
        push("error");
        return;
      }
      push(result.status as ScanStatus, result.memberName);
    } catch {
      seenRef.current.delete(token);
      push("network");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (loopRef.current !== null) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Ctor) {
      setCamera({ kind: "unsupported" });
      return;
    }
    setCamera({ kind: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCamera({ kind: "denied" });
      } else {
        setCamera({ kind: "failed", message: "Couldn't start the camera on this device." });
      }
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

    const detector = new Ctor({ formats: ["qr_code"] });
    setCamera({ kind: "running" });

    loopRef.current = window.setInterval(async () => {
      const el = videoRef.current;
      if (!el || el.readyState < 2) return;
      let codes: DetectedBarcode[];
      try {
        codes = await detector.detect(el);
      } catch {
        return; // a single dropped frame is not worth surfacing
      }
      for (const code of codes) {
        const token = code.rawValue?.trim();
        if (!token || seenRef.current.has(token)) continue;
        seenRef.current.add(token);
        void submitToken(token);
      }
    }, 250);
  }, [submitToken]);

  useEffect(() => stopCamera, [stopCamera]);

  const recorded = rows.filter((r) => r.status === "success").length;
  const failed = rows.filter((r) => STATUS_COPY[r.status].tone === "bad").length;
  const selected = classes?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-tx-1">Scan cards</h1>
        <p className="mt-1 text-sm text-tx-3">
          Pick the session, then hold your phone over each card in turn. Only today&rsquo;s classes
          are listed, so a scan can never land on the wrong day.
        </p>
      </div>

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
          <span className="block text-sm font-medium text-tx-2">Session</span>
          <div className="flex flex-wrap gap-2">
            {classes.map((c) => (
              <Button
                key={c.id}
                variant={c.id === selectedId ? "primary" : "secondary"}
                size="compact"
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
            <div>
              <p className="text-sm font-medium text-tx-1">
                {selected.name} · {selected.startTime}–{selected.endTime}
              </p>
              <p className="text-sm text-tx-3">
                {recorded} checked in this scan
                {failed > 0 ? ` · ${failed} didn't record` : ""}
              </p>
            </div>
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
                Start camera
              </Button>
            )}
          </div>

          <video
            ref={videoRef}
            className={camera.kind === "running" ? "mt-4 w-full max-w-md rounded-lg" : "hidden"}
            muted
            playsInline
          />

          {(camera.kind === "unsupported" || camera.kind === "denied" || camera.kind === "failed") && (
            <div className="mt-4 rounded-lg border border-bd-default p-3">
              <p className="text-sm font-medium text-tx-1">
                {camera.kind === "unsupported" && "This browser can't scan QR codes"}
                {camera.kind === "denied" && "Camera access was blocked"}
                {camera.kind === "failed" && camera.message}
              </p>
              <p className="mt-1 text-sm text-tx-3">
                {camera.kind === "unsupported" &&
                  "Chrome on Android, or Safari on a recent iPhone, can. "}
                {camera.kind === "denied" &&
                  "Allow the camera for this site in your browser settings, then start again. "}
                You can take the register by hand in the meantime — nothing is lost.
              </p>
              <Link
                href="/dashboard/coach"
                className="mt-2 inline-block text-sm font-medium text-tx-1 underline"
              >
                Open the coach register
              </Link>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-tx-2">Scans</h2>
          <ul className="divide-y divide-[color:var(--bd-default)] rounded-lg border border-bd-default bg-sf-1">
            {rows.map((r) => {
              const copy = STATUS_COPY[r.status];
              return (
                <li key={`${r.token}-${r.at}`} className="flex items-start justify-between gap-3 p-3">
                  <div>
                    <p className="text-sm font-medium text-tx-1">{r.memberName ?? "Unknown card"}</p>
                    {copy.hint && <p className="text-sm text-tx-3">{copy.hint}</p>}
                  </div>
                  <span
                    className={
                      copy.tone === "ok"
                        ? "shrink-0 text-sm font-medium text-[var(--hue-success-ink)]"
                        : copy.tone === "warn"
                          ? "shrink-0 text-sm font-medium text-[var(--hue-warning-ink)]"
                          : "shrink-0 text-sm font-medium text-[var(--hue-danger-ink)]"
                    }
                  >
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
