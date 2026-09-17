/**
 * The one decision the scanner's detect loop makes about a broken detector.
 *
 * `BarcodeDetector.detect()` rejecting on a single frame is noise — a dropped
 * frame, a paused track — and is rightly swallowed. Rejecting on EVERY frame is
 * a platform with the constructor but no barcode backend (Chrome on Windows or
 * Linux desktop; an Android whose Play Services module has not downloaded), and
 * swallowing that leaves a live-looking camera under which nothing ever happens.
 *
 * Pure, so it is tested without a camera. The caller holds the counter per
 * camera start (a `let` local to `startCamera`) so a Stop→Start begins at zero
 * and a rejection from a previous start's in-flight detect mutates a dead
 * closure — and it checks its per-start generation before acting, because the
 * *effect* (`stopCamera()`) reads live refs.
 */

/** Consecutive rejections before the detector is declared dead. */
export const DETECTOR_FAILURE_LIMIT = 5;

export type DetectorState =
  | { kind: "keep-going"; failures: number }
  | { kind: "dead"; failures: number };

/** Next state after one more `detect()` rejection. */
export function nextDetectorState(consecutiveFailures: number): DetectorState {
  const failures = consecutiveFailures + 1;
  return failures >= DETECTOR_FAILURE_LIMIT
    ? { kind: "dead", failures }
    : { kind: "keep-going", failures };
}
