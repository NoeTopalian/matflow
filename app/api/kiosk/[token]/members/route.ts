// GET /api/kiosk/[token]/members?q=...
//
// Public-by-design — kiosk URL token IS the auth.
// Returns up to 10 members whose name matches the query (case-insensitive
// substring). Requires q.length >= 2 to prevent dumping the entire roster.
//
// Response intentionally omits PII (email, phone, DOB, medical, payment
// status). Each result carries a short-TTL signed `kioskMemberToken` that
// the kiosk client posts back to the check-in endpoint — so an attacker
// scraping this endpoint cannot enumerate raw memberIds and reuse them.

import { NextResponse } from "next/server";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signKioskMemberToken } from "@/lib/kiosk-token";
import { ageFromDateOfBirth } from "@/lib/age";
import { tenantAdmission, admissionMessage } from "@/lib/tenant-admission";

export const runtime = "nodejs";

const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 10;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ip = getClientIp(req);
  const tokenHash = hashToken(token);
  const rl = await checkRateLimit(`kiosk:lookup:${tokenHash.slice(0, 12)}:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  // THE TOKEN IS RESOLVED FIRST — before the query-length shortcut, which used
  // to sit here and answer `200 { members: [] }` to a token this club never
  // issued. Every other public lookup in the product answers a fabricated
  // identifier with 404, and this one told the holder of a made-up token
  // "that kiosk exists, you just did not type enough" — a free oracle for
  // guessing a kiosk URL sixteen characters at a time, and the one surface
  // where a paused club's refusal could be skipped by omitting `?q=`.
  // The refusal for an unknown token and the refusal for a short query are now
  // different answers to different questions, in that order.
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { kioskTokenHash: tokenHash },
      select: { id: true, subscriptionStatus: true, deletedAt: true },
    }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // A paused club's roster is not searchable from its own front desk. Refused
  // before the search runs — see the classes route for the full reasoning.
  const admission = tenantAdmission(tenant);
  if (!admission.admits) {
    return NextResponse.json(
      { error: admissionMessage(admission.reason, "member") },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LEN) {
    return NextResponse.json({ members: [] });
  }

  const members = await withTenantContext(tenant.id, (tx) =>
    tx.member.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ["active", "taster"] },
        name: { contains: q, mode: "insensitive" },
      },
      select: {
        id: true,
        name: true,
        accountType: true,
        parentMemberId: true,
        waiverAccepted: true,
        membershipType: true,
        memberRanks: {
          orderBy: { rankSystem: { order: "desc" } },
          take: 1,
          select: {
            rankSystem: { select: { name: true, color: true } },
          },
        },
        // F6: include linked kids so the kiosk can show a "Who's training
        // today?" picker when a parent taps their name. Only top-level
        // Members (parentMemberId IS NULL) can have kids — we still query
        // unconditionally because the include filter is per-row anyway.
        children: {
          where: { status: { in: ["active", "taster"] } },
          select: {
            id: true,
            name: true,
            accountType: true,
            waiverAccepted: true,
            dateOfBirth: true,
          },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
      take: MAX_RESULTS,
    }),
  );

  return NextResponse.json({
    members: members.map((m) => {
      // Self can train only if they have a membership AND aren't themselves
      // a kid (kids check in via their parent's tap, not directly). A parent
      // with no own membership has membershipType: null — they shouldn't
      // appear as a "Self" option in the picker. The picker logic on the
      // client uses selfTrainable to decide.
      const selfTrainable =
        m.accountType !== "kids" &&
        !!m.membershipType &&
        m.parentMemberId === null;

      return {
        kioskMemberToken: signKioskMemberToken({ tenantId: tenant.id, memberId: m.id }),
        name: m.name,
        ageGroup: m.accountType, // adult | junior | kids | parent
        beltName: m.memberRanks[0]?.rankSystem.name ?? null,
        beltColor: m.memberRanks[0]?.rankSystem.color ?? null,
        waiverOk: m.waiverAccepted,
        selfTrainable,
        // Linked kids — each gets a freshly-signed kiosk token so the same
        // /checkin endpoint can be hit per selection without leaking raw
        // member IDs to the client.
        linkedKids: m.children.map((kid) => ({
          kioskMemberToken: signKioskMemberToken({
            tenantId: tenant.id,
            memberId: kid.id,
          }),
          name: kid.name,
          ageGroup: kid.accountType,
          waiverOk: kid.waiverAccepted,
          // Derived age, NOT the date of birth. This endpoint is
          // unauthenticated by design and searchable on a two-character
          // prefix, so it previously let anyone holding the kiosk URL harvest
          // minors' exact birth dates — while the header comment above claimed
          // the response omitted DOB. The picker only ever rendered the age.
          age: ageFromDateOfBirth(kid.dateOfBirth),
        })),
      };
    }),
  });
}
