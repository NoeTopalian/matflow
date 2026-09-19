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
 *     creditsRemaining = totalCredits - creditsRedeemed - creditsRevoked
 *
 * The second line is the one that matters in production. `refundedPence` is
 * Stripe's CUMULATIVE figure, and Stripe reports the same refund twice: once to
 * the owner refund route, and again as the `charge.refunded` echo. Subtracting
 * from `creditsRemaining` therefore applied one refund twice — £25 back on a
 * £100 ten-class pack took two classes at the desk and two more when the echo
 * landed, so a quarter of the money bought back two fifths of the classes.
 * Computing from the pack AS SOLD, less the classes actually attended, gives
 * the same answer however many times the same total is reported.
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
  /**
   * `ClassPackRedemption` rows for this pack — the classes the member has
   * actually attended. Required, and deliberately not derived from
   * `totalCredits - creditsRemaining`: that difference includes credits an
   * earlier report of THIS refund already revoked, which is exactly how the
   * same £25 came to be charged twice.
   */
  creditsRedeemed: number;
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
  const { totalCredits, creditsRemaining, creditsRedeemed, paidPence, refundedPence } = input;

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

  // The whole answer is computed from the pack AS SOLD, never from what is left
  // of it. `refundedPence` is Stripe's CUMULATIVE total and Stripe reports the
  // same refund more than once — the owner refunds at the desk and
  // `charge.refunded` echoes the identical figure back through the webhook. A
  // subtraction from `creditsRemaining` therefore ran twice on one refund and
  // took the classes twice; a subtraction from `totalCredits` cannot, however
  // many times the same total is reported.
  const revokedTotal = Math.floor((refundedPence * totalCredits) / paidPence);
  const remaining = Math.max(0, totalCredits - creditsRedeemed - revokedTotal);

  // What THIS report took back, for the audit line: the distance the pack
  // actually moved. A repeat of a refund already applied moves it nowhere.
  // Never negative — an echo arriving after the member attended another class
  // must not read as credits being handed back.
  const creditsRevoked = Math.max(0, creditsRemaining - remaining);

  return {
    creditsRemaining: Math.min(creditsRemaining, remaining),
    status: null,
    creditsRevoked,
  };
}
