import { createHmac, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { normaliseIp } from "@/lib/login-fingerprint";

/**
 * Password-failure lockout, v2 (SF-35 + SF-59, security campaign iteration 2,
 * lane A2, 9 Oct 2026).
 *
 * WHAT IT REPLACES. Ten consecutive wrong passwords set `lockedUntil` on the
 * account row for an hour, and the sign-in form then said "This account is
 * temporarily locked" — only for an account that EXISTS (SEC-002: after ten
 * guesses the message is an existence oracle). And anyone who knew an address
 * could re-lock it every ~75 minutes with ~10 requests, from anywhere, keeping
 * the real person out indefinitely (SEC-079); in front of it a per-address
 * attempt limit (5 per 15 minutes from ALL sources) let five requests do the
 * same for a quarter of an hour.
 *
 * THE MODEL NOW. Failures are counted against the ADDRESS STRING (club +
 * normalised email), never against a row, so an address with no account
 * reaches exactly the same state after exactly the same requests: the answer
 * cannot depend on whether the account exists. Two counters, one hour each:
 *
 *   pair  — failures for this address from this network (/24 IPv4, /48 IPv6).
 *           PAIR_MAX reached → refused from this network. Applies to everyone.
 *   addr  — failures for this address from all networks. ADDR_MAX reached →
 *           refused from any network that is NOT a known device of the
 *           account (a LoginEvent for this person on this device fingerprint,
 *           not disowned, seen in the last KNOWN_DEVICE_DAYS). The person keeps
 *           signing in from the phone and laptop they always use while an
 *           attacker elsewhere holds the counter up; the attacker gains nothing
 *           from that exemption, because their own network is still capped by
 *           `pair`, and a guess from a known device must also come from the
 *           victim's own network AND browser family.
 *
 * Only FAILURES count (a correct password spends nothing), and a success
 * clears this network's `pair` counter. The `addr` counter is not cleared by a
 * success: it is shared, and resetting it whenever the real person signs in
 * would hand a distributed guesser a fresh budget.
 *
 * The refusal is ONE generic answer for every throttle and lock, worded so it
 * is true whether or not the account exists; the detail (which counter, the
 * hashed subject) goes to the server log only.
 *
 * THE SLOT IS RESERVED BEFORE THE PASSWORD IS JUDGED (R6-N1, lane A4,
 * 10 Oct 2026). v2 as first built read the counters, ran bcrypt, and only
 * then inserted the failure, so requests that overlapped all read the same
 * count: 40 concurrent guesses from 40 networks at a fresh address were ALL
 * judged (cap 10) and the right password, 40th, was admitted (review R6, both
 * roles; tests/integration/sec-a4-lockout-burst-db). Now lockoutState() takes
 * one failure slot in BOTH counters atomically before the caller looks at the
 * password, by lane C3's construction (lib/rate-limit.ts checkDbRateLimit): a
 * transaction-scoped advisory lock in the same namespace, then ONE
 * conditional insert that counts both windows and inserts both rows only if
 * the caps allow. One lock on the ADDRESS bucket serialises both counters,
 * because every pair bucket belongs to exactly one address. A burst gets
 * exactly ADDR_MAX slots; the rest are refused rate_limited without a
 * verdict. A correct password gives its address slot back
 * (clearPairOnSuccess), so the person never spends the shared budget; a wrong
 * one keeps it, because the reservation IS the recorded failure. Every
 * address, with or without an account, reserves the same way, so the cost
 * stays existence-independent (tests/unit/sec-a3-failure-path-cost).
 *
 * FAIL CLOSED. Every read here throws on a database error and the caller
 * refuses the sign-in. The counters live in RateLimitHit (lane F's table and
 * pruning: rows older than an hour are swept, which matches WINDOW_MS); the
 * bucket names carry an HMAC of the address, not the address.
 */

export const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
export const PAIR_MAX = 10;
export const ADDR_MAX = 10;
export const KNOWN_DEVICE_DAYS = 90;

/** The words a person sees for every lockout / throttle. True whether or not the account exists. */
export const SIGN_IN_THROTTLED_MESSAGE =
  "Too many sign-in attempts for this email. Wait up to an hour and try again, sign in from a device you've used before, or use a sign-in link or password reset instead.";

/**
 * The client IP for sign-in, by the same trust order as getClientIp() in
 * lib/rate-limit.ts (x-vercel-forwarded-for, then x-real-ip, then the LAST
 * x-forwarded-for hop; "unknown" otherwise). A copy rather than an import so
 * the many unit tests that replace lib/rate-limit wholesale do not silently
 * change how sign-in reads the network; tests/unit/sec-a2-lockout-oracle.test.ts
 * pins the two to the same answers.
 */
export function requestClientIp(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel.split(",")[0].trim();
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

function keyed(kind: string, ...parts: string[]): string {
  const mac = createHmac("sha256", AUTH_SECRET_VALUE ?? "")
    .update(`auth-lockout.v2.${kind}\u0000${parts.join("\u0000")}`)
    .digest("hex")
    .slice(0, 40);
  return `authfail:${kind}:${mac}`;
}

export interface LockoutKeys {
  pair: string;
  addr: string;
}

export function lockoutKeys(tenantSlug: string, email: string, clientIp: string): LockoutKeys {
  const slug = tenantSlug.toLowerCase().trim();
  const addr = email.toLowerCase().trim();
  return {
    pair: keyed("pair", slug, addr, normaliseIp(clientIp)),
    addr: keyed("addr", slug, addr),
  };
}

/**
 * The advisory-lock namespace: the SAME value as RATE_LIMIT_LOCK_NS in
 * lib/rate-limit.ts (ASCII "RLHT"), so a bucket is serialised by one lock
 * whichever module touches it. A copy rather than an import for the reason
 * requestClientIp() is one: many unit tests replace lib/rate-limit wholesale.
 * tests/unit/sec-a4-lockout-reservation.test.ts pins the two equal.
 */
export const LOCKOUT_LOCK_NS = 0x524c4854;

async function countRecent(bucket: string): Promise<number> {
  return prisma.rateLimitHit.count({
    where: { bucket, hitAt: { gte: new Date(Date.now() - LOCKOUT_WINDOW_MS) } },
  });
}

/** One failure slot held in both counters. The address row is given back on a correct password. */
export interface LockoutReservation {
  pairId: string;
  addrId: string;
  /** The address-wide count including this slot. */
  addrCountAfter: number;
}

export type LockoutState =
  | { blocked: false; addrCapped: boolean; reservation?: LockoutReservation }
  | { blocked: true; reason: "pair" | "addr" };

/**
 * A burst against one address queues on the lock INSIDE the transaction, so
 * Prisma's defaults (2 s to start, 5 s in all) refused the tail of a burst
 * with a transaction error (fail closed, but a needless refusal for the real
 * person). An interactive transaction rather than a batch, because Prisma 7
 * with the pg driver adapter applies its options only to the interactive form
 * (measured: the batch form still expired at 5000 ms). Same statements, same
 * round trips: BEGIN, lock, conditional insert, COMMIT.
 *
 * THE BOUND IS OWNED HERE, NOT BY PRISMA'S TIMER (SF-135, lane L1, 11 Oct
 * 2026). The burst suites exited 1 with every cell green: an unhandled
 * "Connection terminated unexpectedly" / ConnectionClosed from Prisma's own
 * transaction-timeout timer, whose ROLLBACK queues behind a statement still in
 * flight (it never interrupts it) and rejects with no handler when the
 * connection then fails — while the statement's own rejection reached the
 * caller as a refusal. lib/rate-limit.ts (checkDbRateLimit) has the full
 * account; the construction is the same here:
 *  - the lock statement sets lock_timeout and statement_timeout
 *    transaction-locally (set_config(…, true): reset by COMMIT/ROLLBACK,
 *    nothing left on the pooled connection), RESERVE_TX_BOUND_MS each, the
 *    same 10 s ceiling the old Prisma timer nominally gave;
 *  - Prisma's transaction timeout AND maxWait are beyond those bounds, so
 *    Prisma's timer never fires under our statements and Prisma never
 *    abandons a half-finished start (SF-136; lib/rate-limit.ts explains);
 *    the wait for a connection is bounded by the pool's own 10 s deadline,
 *    the same ceiling the old maxWait gave.
 * Any failure of the transaction — a dead connection, a bound reached,
 * anything unexpected — is thrown as a LockoutReservationError with a reason,
 * after one log line that names only the reason (never the address, the
 * network or the bucket key). The caller refuses the sign-in on any throw.
 */
export const RESERVE_TX_BOUND_MS = 10_000;
const PRISMA_TIMER_OUT_OF_REACH_MS = 60 * 60 * 1000;
const RESERVE_TX_OPTIONS = { maxWait: PRISMA_TIMER_OUT_OF_REACH_MS, timeout: PRISMA_TIMER_OUT_OF_REACH_MS } as const;

export type LockoutReservationFailure = "unreachable" | "pool-timeout" | "lock-timeout" | "statement-timeout" | "error";

/** A reservation that could not be completed. The attempt holds no slot and must be refused. */
export class LockoutReservationError extends Error {
  readonly reason: LockoutReservationFailure;
  constructor(reason: LockoutReservationFailure, cause: unknown) {
    super(`lockout reservation failed (${reason})`, { cause });
    this.name = "LockoutReservationError";
    this.reason = reason;
  }
}

function reservationFailureReason(err: unknown): LockoutReservationFailure {
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown }; cause?: { originalCode?: unknown } } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const sqlState = String(e?.meta?.code ?? e?.cause?.originalCode ?? "");
  const msg = typeof e?.message === "string" ? e.message : "";
  if (/^P10(0[0-2]|17)$/.test(code) || /reach database|ECONNREFUSED|ENOTFOUND|connection terminated|ConnectionClosed|server has closed the connection|not queryable/i.test(msg)) {
    return "unreachable";
  }
  if (code === "P2024" || /timeout exceeded when trying to connect|timed out fetching a new connection/i.test(msg)) return "pool-timeout";
  if (sqlState === "55P03" || /\b55P03\b|lock timeout/i.test(msg)) return "lock-timeout";
  if (sqlState === "57014" || /\b57014\b|statement timeout/i.test(msg)) return "statement-timeout";
  return "error";
}

type ReserveResult = { reservation: LockoutReservation } | { refused: "pair" | "addr" };

/**
 * Atomically: lock the address bucket (transaction-scoped, so safe through
 * the PgBouncer pooler and released by COMMIT/ROLLBACK), count both windows on
 * the database clock, and insert one row in each counter only if pair is
 * below PAIR_MAX and addr is below ADDR_MAX (or the device is exempt). The
 * lock is taken in an EARLIER statement than the count, so the counting
 * statement's READ COMMITTED snapshot sees every slot the previous holder
 * committed (lib/rate-limit.ts explains why one statement alone is not enough).
 */
async function reserve(keys: LockoutKeys, addrExempt: boolean): Promise<ReserveResult> {
  const pairId = `lk_${randomUUID()}`;
  const addrId = `lk_${randomUUID()}`;
  let rows: Array<{ pairCount: number; addrCount: number; inserted: number }>;
  try {
    rows = await reserveTx(keys, addrExempt, pairId, addrId);
  } catch (err) {
    const reason = reservationFailureReason(err);
    console.error(`[auth-lockout] reservation failed reason=${reason} outcome=refused`);
    throw new LockoutReservationError(reason, err);
  }
  const row = rows[0];
  if (!row) throw new Error("lockout reservation returned no row");
  if (Number(row.inserted) === 2) {
    return { reservation: { pairId, addrId, addrCountAfter: Number(row.addrCount) + 1 } };
  }
  return { refused: Number(row.pairCount) >= PAIR_MAX ? "pair" : "addr" };
}

/** The transaction itself: the bounded lock (10000 ms = RESERVE_TX_BOUND_MS), then the one conditional insert. */
function reserveTx(keys: LockoutKeys, addrExempt: boolean, pairId: string, addrId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`WITH bound AS MATERIALIZED (SELECT set_config('lock_timeout', '10000ms', true) AS lt, set_config('statement_timeout', '10000ms', true) AS st) SELECT pg_advisory_xact_lock(${LOCKOUT_LOCK_NS}::int4, hashtext(${keys.addr}::text)) FROM bound`;
    return tx.$queryRaw<Array<{ pairCount: number; addrCount: number; inserted: number }>>`
      WITH clock AS (
        SELECT (statement_timestamp() AT TIME ZONE 'UTC') AS t
      ), pw AS (
        SELECT count(*)::int AS n FROM "RateLimitHit" h, clock
        WHERE h.bucket = ${keys.pair}::text
          AND h."hitAt" >= clock.t - make_interval(secs => ${LOCKOUT_WINDOW_MS}::float8 / 1000)
      ), aw AS (
        SELECT count(*)::int AS n FROM "RateLimitHit" h, clock
        WHERE h.bucket = ${keys.addr}::text
          AND h."hitAt" >= clock.t - make_interval(secs => ${LOCKOUT_WINDOW_MS}::float8 / 1000)
      ), go AS (
        SELECT pw.n AS pn, aw.n AS an,
               (pw.n < ${PAIR_MAX}::int AND (aw.n < ${ADDR_MAX}::int OR ${addrExempt}::boolean)) AS ok
        FROM pw, aw
      ), ins AS (
        INSERT INTO "RateLimitHit" (id, bucket, "hitAt")
        SELECT v.id, v.bucket, clock.t
        FROM (VALUES (${pairId}::text, ${keys.pair}::text), (${addrId}::text, ${keys.addr}::text)) AS v(id, bucket), clock, go
        WHERE go.ok
        RETURNING 1
      )
      SELECT go.pn AS "pairCount", go.an AS "addrCount", (SELECT count(*)::int FROM ins) AS "inserted" FROM go`;
  }, RESERVE_TX_OPTIONS);
}

/**
 * Where this address stands, BEFORE the password is looked at — and, when it
 * is not blocked, the failure slot this attempt holds (see the header).
 *
 * The unlocked read first: an address or network already at its cap is
 * refused in one round trip without queueing on the lock (an attacker
 * hammering a capped address must not hold pool connections). Below the cap
 * the reservation decides. `isKnownDevice` is consulted whenever the address
 * cap is what stands in the way — at the read, or when a concurrent burst
 * filled the cap between the read and the reservation — and must not throw
 * for an address with no account (the caller passes a resolver that answers
 * false without a lookup difference — see auth.ts).
 */
export async function lockoutState(
  keys: LockoutKeys,
  isKnownDevice: () => Promise<boolean>,
): Promise<LockoutState> {
  const [pair, addr] = await Promise.all([countRecent(keys.pair), countRecent(keys.addr)]);
  if (pair >= PAIR_MAX) return { blocked: true, reason: "pair" };
  let known: boolean | undefined;
  if (addr >= ADDR_MAX) {
    // Always resolved, so the known and unknown paths cost the same.
    known = await isKnownDevice();
    if (!known) return { blocked: true, reason: "addr" };
  }
  let r = await reserve(keys, known === true);
  if ("refused" in r && r.refused === "addr" && known === undefined) {
    // A concurrent burst filled the cap after our read: the exemption is decided now.
    known = await isKnownDevice();
    if (known) r = await reserve(keys, true);
  }
  if ("refused" in r) return { blocked: true, reason: r.refused };
  return { blocked: false, addrCapped: known === true, reservation: r.reservation };
}

/**
 * A wrong password (or a row-locked account): the slot reserved before the
 * password was judged IS the recorded failure, so nothing more is written.
 * Returns the address-wide count including it. No reservation means the
 * state did not come from lockoutState — refuse rather than count late.
 */
export async function recordFailure(_keys: LockoutKeys, reservation?: LockoutReservation): Promise<number> {
  if (!reservation) throw new Error("lockout: a failure without a reservation (the slot must be taken before bcrypt)");
  return reservation.addrCountAfter;
}

/**
 * A correct password: this network's counter starts again, and the address
 * slot this attempt reserved is given back, so the person never spends the
 * shared budget. One statement. Other attempts' address slots are untouched
 * — resetting the address counter on a success would hand a distributed
 * guesser a fresh budget.
 */
export async function clearPairOnSuccess(keys: LockoutKeys, reservation?: LockoutReservation): Promise<void> {
  await prisma.rateLimitHit.deleteMany({
    where: reservation ? { OR: [{ bucket: keys.pair }, { id: reservation.addrId }] } : { bucket: keys.pair },
  });
}
