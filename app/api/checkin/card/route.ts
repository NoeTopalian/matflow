// Coach card-scan check-in — the consumer of the printed member ID card.
//
// WHY THIS EXISTS
// ---------------
// `signCardToken` has been minting five-year credentials onto laminated cards
// since the print sheet shipped, and until this route existed `verifyCardToken`
// had no caller anywhere outside its own unit test. The product could print a
// credential it could not read. No member may be issued a card until this
// route and the revocation path exist — see docs and the plan's hard gate.
//
// WHAT A SCAN IS ALLOWED TO DO
// ----------------------------
// A coach standing in front of the class is recording who was actually there,
// so this runs the ADMIN gate profile: no rank gate, no roster allow-list, no
// time window, no payment coverage. That matches the manual register on the
// same screen. It deliberately does NOT match the kiosk, which is a public
// unattended surface and gates far harder.
//
// The permission rule is copied from the sibling register
// (app/api/coach/instances/[id]/attendance) rather than from /api/checkin:
// privileged roles may write to any instance, a coach only to instances they
// teach. Two adjacent screens disagreeing about the same permission is worse
// than either rule on its own, and /api/checkin has no instructor narrowing at
// all — inheriting it would have silently let every coach in the tenant scan
// members into any class while the manual toggle beside it refused them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiStaff } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { withTenantContext } from "@/lib/prisma-tenant";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyCardToken } from "@/lib/card-token";
import { performCheckin } from "@/lib/checkin";
import { logAudit } from "@/lib/audit-log";

/**
 * One request per card is what the client actually sends, so a dropped
 * connection costs one card rather than a whole class's register. The array
 * exists so the contract is honest about looping and so a future offline queue
 * can flush several at once; it is not an invitation to batch a class into a
 * single all-or-nothing request.
 */
const MAX_TOKENS_PER_REQUEST = 25;

/**
 * A stack of cards is a burst by definition — the kiosk's 30-per-60s bucket
 * would reject a coach halfway through a busy mat. Sized for a large class
 * scanned fast, plus retries.
 *
 * `failClosed` because lib/rate-limit.ts otherwise degrades to per-instance
 * memory on a database error, which is exactly when a limiter matters. Almost
 * no caller in this codebase passes it; this one does.
 */
const SCAN_RATE_MAX = 240;
const SCAN_RATE_WINDOW_MS = 5 * 60 * 1000;

const schema = z.object({
  classInstanceId: z.string().min(1),
  tokens: z.array(z.string().min(1).max(4096)).min(1).max(MAX_TOKENS_PER_REQUEST),
});

/**
 * Every way a single scan can end. The coach's screen renders all of them —
 * a scan that did not record must never be invisible behind a success count.
 */
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
  | "error";

type ScanResult = {
  /** Position in the submitted `tokens` array, so the client can correlate
   *  without the token itself travelling back through logs or UI state. */
  index: number;
  status: ScanStatus;
  memberId?: string;
  memberName?: string;
};

const PRIVILEGED_ROLES = ["owner", "manager", "admin"];

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId, role } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { classInstanceId, tokens } = parsed.data;

  let rl;
  try {
    rl = await checkRateLimit(`checkin:card:${tenantId}:${userId}`, SCAN_RATE_MAX, SCAN_RATE_WINDOW_MS, {
      failClosed: true,
    });
  } catch {
    // failClosed threw: the limiter could not be consulted. Refusing is the
    // point — degrading to an unlimited in-memory bucket here would remove the
    // limit precisely when the database is unhealthy.
    return NextResponse.json({ error: "Check-in is temporarily unavailable" }, { status: 503 });
  }
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many scans — wait a moment and carry on" },
      { status: 429 },
    );
  }

  const isPrivileged = PRIVILEGED_ROLES.includes(role);

  // The instance is resolved ONCE, under the same narrowing the manual register
  // applies. Doing it per token would let a coach's first rejected scan be
  // indistinguishable from a bad card.
  const instance = await withTenantContext(tenantId, (tx) =>
    tx.classInstance.findFirst({
      where: {
        id: classInstanceId,
        class: { tenantId, ...(isPrivileged ? {} : { instructorId: userId }) },
      },
      select: { id: true, isCancelled: true },
    }),
  );
  if (!instance) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }
  if (instance.isCancelled) {
    return NextResponse.json({ error: "That class was cancelled" }, { status: 409 });
  }

  // De-duplicate by exact string before touching the database. This is only
  // sound because lib/card-token.ts decodes canonically: one card is exactly
  // one string, so a scanner emitting a trailing newline cannot present as a
  // second distinct card and burn a second class-pack credit.
  const firstIndexByToken = new Map<string, number>();
  const duplicatesInRequest: number[] = [];
  tokens.forEach((t, i) => {
    if (firstIndexByToken.has(t)) duplicatesInRequest.push(i);
    else firstIndexByToken.set(t, i);
  });

  const results: ScanResult[] = new Array(tokens.length);
  for (const i of duplicatesInRequest) {
    results[i] = { index: i, status: "duplicate" };
  }

  // Verify signatures first — cheap, and it means only genuine cards reach the
  // database at all.
  const verified: { index: number; memberId: string; cardVersion: number }[] = [];
  for (const [token, index] of firstIndexByToken) {
    const v = verifyCardToken(token, tenantId);
    if (!v.ok) {
      const status: ScanStatus =
        v.reason === "expired" ? "expired" : v.reason === "tenant-mismatch" ? "wrong_tenant" : "invalid";
      results[index] = { index, status };
      continue;
    }
    verified.push({ index, memberId: v.memberId, cardVersion: v.cardVersion });
  }

  // One lookup for every member a genuine card names, rather than one per card.
  // `cardVersion` is the revocation handle: a card printed before the column was
  // bumped is stale and must be refused even though its signature is perfect.
  const memberIds = [...new Set(verified.map((v) => v.memberId))];
  const members = memberIds.length
    ? await withTenantContext(tenantId, (tx) =>
        tx.member.findMany({
          where: { id: { in: memberIds }, tenantId },
          select: { id: true, name: true, cardVersion: true },
        }),
      )
    : [];
  const memberById = new Map(members.map((m) => [m.id, m]));

  let recorded = 0;
  for (const v of verified) {
    const member = memberById.get(v.memberId);
    if (!member) {
      results[v.index] = { index: v.index, status: "member_not_found" };
      continue;
    }
    if (member.cardVersion !== v.cardVersion) {
      // The card was revoked and reprinted. Refusing here is the whole reason
      // verifyCardToken returns the version rather than swallowing it.
      results[v.index] = {
        index: v.index,
        status: "revoked",
        memberId: member.id,
        memberName: member.name,
      };
      continue;
    }

    const outcome = await performCheckin({
      tenantId,
      memberId: member.id,
      classInstanceId,
      method: "qr",
      // Admin profile: a coach is physically present and recording reality.
      enforceRankGate: false,
      enforceRosterGate: false,
      enforceTimeWindow: false,
      requireCoverage: false,
      checkedInByUserId: userId,
    });

    const base = { index: v.index, memberId: member.id, memberName: member.name };
    switch (outcome.kind) {
      case "success":
        recorded += 1;
        results[v.index] = { ...base, status: "success" };
        break;
      case "duplicate":
        results[v.index] = { ...base, status: "duplicate" };
        break;
      case "class_not_found":
        results[v.index] = { ...base, status: "class_not_found" };
        break;
      case "class_cancelled":
        results[v.index] = { ...base, status: "class_cancelled" };
        break;
      case "member_not_found":
        results[v.index] = { ...base, status: "member_not_found" };
        break;
      default:
        // rank_below / rank_above / roster_not_listed / outside_window /
        // no_coverage cannot occur with every gate disabled, so reaching here
        // means something genuinely unexpected. Report it as a failure rather
        // than mapping it to a friendlier status that hides it.
        results[v.index] = { ...base, status: "error" };
        break;
    }
  }

  if (recorded > 0) {
    await logAudit({
      tenantId,
      userId,
      action: "attendance.card_scan",
      entityType: "ClassInstance",
      entityId: classInstanceId,
      metadata: {
        classInstanceId,
        scanned: tokens.length,
        recorded,
        memberIds: results.filter((r) => r.status === "success").map((r) => r.memberId),
      },
      req,
    });
  }

  return NextResponse.json({
    results,
    recorded,
    failed: results.filter((r) => r.status !== "success").length,
  });
}
