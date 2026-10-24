/**
 * Which camera reads of a card become requests — the scanner's de-duplication
 * and retry rule, pure so it is tested without a camera.
 *
 * A camera decodes the same card four times a second for as long as it is in
 * view. One continuous stretch of reads is ONE HOLD, and one hold sends at most
 * one request: rapid repeat reads of the same token while it is in flight, or
 * while it stays under the lens after its answer, are dropped.
 *
 * A new hold starts when the token is read again after it has been out of view
 * for at least `HOLD_GAP_MS`. After a RETRYABLE failure (the request never got
 * an answer, or the server could not record it) the next new hold sends a fresh
 * request — every time, not only once: before this rule the token stayed "seen"
 * after the second failure, so a third hold did nothing while the row still
 * told the coach to hold the card again.
 *
 * Requiring a new hold, rather than un-seeing the token on settle, is what keeps
 * a card left lying under the lens through a database blip from resubmitting at
 * 4 Hz and spending the card route's rate limit within a minute: a still card is
 * one hold however long it lies there.
 *
 * Every other outcome (recorded, already in, refused, a 200 error, signed out,
 * rate limited…) keeps the token settled for the rest of the session, because
 * for those the row sends the coach somewhere else and rescanning would not
 * help.
 */

/** Out of view this long, then read again, is a new hold. Four scan ticks. */
export const HOLD_GAP_MS = 1000;

type TokenState = {
  /** When the token was last decoded. */
  lastReadAt: number;
  /** When the current hold began. */
  holdStartedAt: number;
  /** The hold that sent the latest request. */
  attemptHoldStartedAt: number;
  /** in_flight: awaiting an answer. retryable: answered with a retryable failure. settled: final. */
  phase: "in_flight" | "retryable" | "settled";
};

export class HoldTracker {
  private readonly tokens = new Map<string, TokenState>();

  constructor(private readonly gapMs: number = HOLD_GAP_MS) {}

  /**
   * One decode of `token` at `now` (ms). Returns "submit" when this read must
   * send a request, otherwise "ignore". Call on every decode, including ones
   * that will be ignored: the read times are what tell a still card from a
   * lifted-and-replaced one.
   */
  read(token: string, now: number): "submit" | "ignore" {
    const t = this.tokens.get(token);
    if (!t) {
      this.tokens.set(token, { lastReadAt: now, holdStartedAt: now, attemptHoldStartedAt: now, phase: "in_flight" });
      return "submit";
    }
    if (now - t.lastReadAt >= this.gapMs) t.holdStartedAt = now;
    t.lastReadAt = now;
    if (t.phase === "retryable" && t.holdStartedAt !== t.attemptHoldStartedAt) {
      t.phase = "in_flight";
      t.attemptHoldStartedAt = t.holdStartedAt;
      return "submit";
    }
    return "ignore";
  }

  /**
   * The request for `token` answered. `retryable` outcomes re-arm the token for
   * the next new hold; anything else settles it. A hold that began while the
   * request was in flight counts as new, so a coach who lifted and replaced the
   * card before the answer arrived is not made to lift it again.
   */
  settled(token: string, retryable: boolean): void {
    const t = this.tokens.get(token);
    if (!t) return;
    t.phase = retryable ? "retryable" : "settled";
  }

  /** True once the token has been read this session. */
  has(token: string): boolean {
    return this.tokens.has(token);
  }
}
