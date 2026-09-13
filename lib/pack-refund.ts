/**
 * How many class-pack credits a refund actually takes back.
 *
 * The defect this exists to remove: every pack-void site in the product did
 * `{ status: "refunded", creditsRemaining: 0 }` the moment ANY refund settled.
 * So a £5 goodwill refund on a £100 ten-class pack destroyed all ten classes —
 * the member was handed back 5% of their money and lost 100% of what they
 * bought. Four sites did it (the owner refund route, `charge.refunded`,
 * `invoice.voided`, and dispute-lost), which is the same "fixed on one path,
 * left standing on the others" shape as the currency bug; hence one helper both
 * refund paths import, rather than two copies that will drift.
 *
 * The apportionment is deliberately per-credit rather than per-penny. A pack is
 * sold as N whole classes at a known price each, so a refund revokes the number
 * of WHOLE classes it paid for and no more:
 *
 *     pricePerCredit = paidPence / totalCredits
 *     creditsRevoked = floor(refundedPence / pricePerCredit)
 *
 * On a £100 / 10-class pack that means £5 back revokes nothing (£5 does not buy
 * a class), £25 back revokes two, and the full £100 voids the pack outright.
 * Rounding down is the honest direction: it never takes a class the member has
 * not been refunded for. The alternative — scaling a fraction of a credit away —
 * would make a token goodwill gesture cost a real class, which is the behaviour
 * being fixed.
 *
 * Status is only ever flipped to "refunded" by a FULL refund, mirroring how the
 * Payment row itself is handled (a partial leaves the payment "succeeded" so the
 * remainder stays refundable). A partially-refunded pack stays "active" with
 * fewer credits; check-in already filters on `creditsRemaining > 0`, so a pack
 * reduced to zero is unusable without lying about why.
 *
 * Deliberately NOT applied to two sites, both correct as they stand:
 *   * `invoice.voided` — a void reverses the whole invoice, so the whole pack
 *     goes with it;
 *   * dispute lost — a chargeback is adversarial, not goodwill; the gym is out
 *     of pocket and the member should not keep spendable credits.
 */

export interface PackRefundInput {
  /** `ClassPack.totalCredits` — the pack as it was sold. */
  totalCredits: number;
  /** `MemberClassPack.creditsRemaining` — what is left right now. */
  creditsRemaining: number;
  /** The funding `Payment.amountPence`. */
  paidPence: number;
  /** Cumulative refunded against that payment, INCLUDING this refund. */
  refundedPence: number;
}

export interface PackRefundOutcome {
  /** What `creditsRemaining` should become. */
  creditsRemaining: number;
  /** `"refunded"` on a full refund; `null` means leave the status alone. */
  status: "refunded" | null;
  /** How many credits this refund took back — for the audit line. */
  creditsRevoked: number;
}

export function packCreditsAfterRefund(input: PackRefundInput): PackRefundOutcome {
  const { totalCredits, creditsRemaining, paidPence, refundedPence } = input;

  // Nothing came back, so nothing is revoked. Guards a `charge.refunded` replay
  // with a zero amount from silently eating credits.
  if (!(refundedPence > 0)) {
    return { creditsRemaining, status: null, creditsRevoked: 0 };
  }

  // Money came back but we cannot apportion it — no price, or no credits to
  // price. Fall back to the whole-pack void rather than guessing a number.
  if (!(paidPence > 0) || !(totalCredits > 0)) {
    return { creditsRemaining: 0, status: "refunded", creditsRevoked: creditsRemaining };
  }

  if (refundedPence >= paidPence) {
    return { creditsRemaining: 0, status: "refunded", creditsRevoked: creditsRemaining };
  }

  // Whole credits the refunded amount actually paid for, capped at what is
  // left: a member who has already used seven of ten cannot have eight taken.
  const revoked = Math.min(
    creditsRemaining,
    Math.floor((refundedPence * totalCredits) / paidPence),
  );

  return {
    creditsRemaining: creditsRemaining - revoked,
    status: null,
    creditsRevoked: revoked,
  };
}
