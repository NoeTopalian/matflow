import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination, nextCursorFor } from "@/lib/pagination";
import { memberCreateSchema } from "@/lib/schemas/member";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { sendEmail } from "@/lib/email";
import { randomBytes } from "crypto";
import { hashToken } from "@/lib/token-hash";
import { getBaseUrl } from "@/lib/env-url";
import { synthesiseKidEmail } from "@/lib/synthesise-kid-email";
import { MAX_KIDS_PER_PARENT } from "@/lib/kids-policy";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";

// Lane 1 iter-1 S-02 [Critical] fix: per-(tenant, user) rate-limit envelope
// on member creation. The route mints a MagicLinkToken + sends an invite
// email to attacker-chosen addresses on success. 30 creates/hour is generous
// for human-paced bulk onboarding (staff adding a cohort one-by-one) but
// kills scripted abuse.
const MEMBER_CREATE_RATE_LIMIT_MAX = 30;
const MEMBER_CREATE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// LB-003: invite tokens for adult members live for 7 days. Kids never get a
// token (they're passwordless by design — parent manages the account).
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildInviteUrl(req: Request, token: string) {
  // Prefer NEXTAUTH_URL in production; fall back to the request origin in dev
  // so local testing doesn't require the env var to be set.
  const base = getBaseUrl(req);
  return `${base}/login/accept-invite?token=${encodeURIComponent(token)}`;
}

const schema = memberCreateSchema;

// synthesiseKidEmail moved to lib/synthesise-kid-email.ts so the parent
// self-serve flow (POST /api/member/children) and this staff create flow
// produce identical formats. Don't reintroduce a local copy.

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Sprint 3 P1 fix: this endpoint exposes member PII (incl. kid synthesised emails),
  // so it must be staff-only. Members and unauthenticated callers cannot list other members.
  const isStaff = ["owner", "manager", "admin", "coach"].includes(session.user.role);
  if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const { take, cursor, skip } = parsePagination(searchParams, { defaultTake: 50, maxTake: 100 });
  const filter = searchParams.get("filter");
  // feat/member-tickable-notes Phase 5: optional ?search=<q> for the
  // AddTaskModal member combobox. Case-insensitive substring on name+email,
  // length-capped to keep the URL parameter bounded.
  const searchRaw = searchParams.get("search");
  const search = searchRaw && searchRaw.trim().length > 0 ? searchRaw.trim().slice(0, 80) : null;

  // Server-side filter pushdown so the chip works across the entire tenant,
  // not just the first page of results.
  const where: {
    tenantId: string;
    parentMemberId?: { not: null };
    OR?: Array<{ name?: { contains: string; mode: "insensitive" }; email?: { contains: string; mode: "insensitive" } }>;
  } = {
    tenantId: session.user.tenantId,
  };
  if (filter === "kids") where.parentMemberId = { not: null };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  try {
    const members = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          status: true,
          paymentStatus: true,
          membershipType: true,
          joinedAt: true,
          waiverAccepted: true,
          accountType: true,
          dateOfBirth: true,
          parentMemberId: true,
          hasKidsHint: true,
          memberRanks: {
            take: 1,
            orderBy: { achievedAt: "desc" },
            select: {
              stripes: true,
              achievedAt: true,
              rankSystem: { select: { name: true, color: true, discipline: true } },
            },
          },
          // feat/member-profile-pictures Track A: current profile picture.
          // Partial unique index (migration 20260606100000) guarantees ≤1 row.
          photos: {
            where: { kind: "profile" },
            select: { url: true },
            take: 1,
          },
        },
        cursor: cursor ? { id: cursor } : undefined,
        skip,
        take,
        orderBy: { joinedAt: "desc" },
      }),
    );

    // feat/member-profile-pictures Track A: flatten photos[0]?.url so
    // consumers (MembersList, AdminCheckin, AddTaskModal combobox) get a
    // simple `profilePictureUrl: string | null` field instead of a nested
    // array. Internal naming `photos` is a relation, not a response field.
    const flattened = members.map(({ photos, ...rest }) => ({
      ...rest,
      profilePictureUrl: photos[0]?.url ?? null,
    }));
    return NextResponse.json({ members: flattened, nextCursor: nextCursorFor(flattened, take) });
  } catch {
    return NextResponse.json({ members: [], nextCursor: null });
  }
}

export async function POST(req: Request) {
  // Lane 1 iter-1 S-02 fix: CSRF guard. Without this, a hostile page could
  // ride a logged-in staff session in a victim browser to spam invites from
  // the gym's transactional sender.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canAdd = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canAdd) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Lane 1 iter-1 S-02 fix: rate-limit envelope after auth + role check so
  // the bucket counts only authenticated staff create attempts (not 401s).
  const rl = await checkRateLimit(
    `member:create:${session.user.tenantId}:${session.user.id}`,
    MEMBER_CREATE_RATE_LIMIT_MAX,
    MEMBER_CREATE_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many member creates. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const isKid = parsed.data.accountType === "kids" || !!parsed.data.parentMemberId;

  // Kids policy: only owners can create kid sub-accounts.
  if (isKid && session.user.role !== "owner") {
    return apiError("Only owners can create kid sub-accounts", 403);
  }

  // Kids must have a parent. Adults must not.
  let parentMemberId: string | null = null;
  if (isKid) {
    if (!parsed.data.parentMemberId) {
      return apiError("Kid sub-accounts require a parent member", 400);
    }
    const parent = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findFirst({
        where: { id: parsed.data.parentMemberId, tenantId: session.user.tenantId },
        select: { id: true, parentMemberId: true },
      }),
    );
    if (!parent) return apiError("Parent member not found in this tenant", 404);
    if (parent.parentMemberId !== null) {
      return apiError("Cannot nest sub-accounts: parent must be top-level", 400);
    }

    // Synergy with POST /api/member/children — both flows enforce the same
    // sanity cap so an owner can't create more kids than a parent can self-add.
    const kidCount = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.count({
        where: { parentMemberId: parent.id, tenantId: session.user.tenantId },
      }),
    );
    if (kidCount >= MAX_KIDS_PER_PARENT) {
      return apiError(`Maximum ${MAX_KIDS_PER_PARENT} kids per parent`, 409);
    }

    parentMemberId = parent.id;
  }

  // Future-DOB rejection — mirrors app/api/member/children/route.ts:61-66 so
  // bad dates are refused identically by both creation paths.
  let dob: Date | null = null;
  if (parsed.data.dateOfBirth) {
    const d = new Date(parsed.data.dateOfBirth);
    if (isNaN(d.getTime())) return apiError("Invalid date of birth", 400);
    if (d > new Date()) return apiError("Date of birth cannot be in the future", 400);
    dob = d;
  }

  // Synthesise email server-side for kids — never trust the client field.
  const email = isKid ? synthesiseKidEmail() : parsed.data.email;

  if (!email) return apiError("Email is required for adult members", 400);

  try {
    const member = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.create({
        data: {
          tenantId: session.user.tenantId,
          name: parsed.data.name,
          email,
          // Kids: passwordless invariant. Adults: handled via signup flow elsewhere.
          passwordHash: null,
          phone: isKid ? null : parsed.data.phone,
          membershipType: parsed.data.membershipType,
          dateOfBirth: dob,
          accountType: parsed.data.accountType ?? "adult",
          parentMemberId,
          // Synergy block: matches POST /api/member/children:97-99 exactly so
          // rows created by the two paths are byte-identical in shape. The
          // schema defaults are the same values today; setting them explicitly
          // guards against any later default drift breaking the equivalence.
          ...(isKid
            ? { status: "active", waiverAccepted: false, onboardingCompleted: true }
            : {}),
        },
        // Audit iter-3-database A8I3-V-H-1 [High]: explicit select on the
        // create result so the response shape doesn't auto-leak any sensitive
        // column added in a future migration. Today these values are all null
        // at create time (passwordHash etc.) — the fix is preventative + GDPR
        // Article 25 data-minimisation hygiene.
        select: {
          id: true, tenantId: true, name: true, email: true, phone: true,
          membershipType: true, status: true, paymentStatus: true,
          accountType: true, dateOfBirth: true, parentMemberId: true,
          hasKidsHint: true, onboardingCompleted: true,
          waiverAccepted: true, joinedAt: true, updatedAt: true,
        },
      }),
    );
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: isKid ? "member.create.kid" : "member.create",
      entityType: "Member",
      entityId: member.id,
      metadata: isKid
        ? { name: member.name, parentMemberId, accountType: member.accountType }
        : { name: member.name, email: member.email },
      req,
    });

    // LB-003 (audit H8): adult members created by staff need a way to log in.
    // Mint a one-time invite token, send the email, and return the URL so the
    // owner has a fallback they can copy if email delivery fails. Kids are
    // passwordless by design — skip the invite path for them.
    let inviteUrl: string | null = null;
    if (!isKid) {
      try {
        // Fix 1: persist HMAC of the token, not the raw value — see lib/token-hash.ts.
        // The raw token goes in the invite email + URL; the DB stores only the hash.
        const token = randomBytes(24).toString("hex");
        const tenant = await withTenantContext(session.user.tenantId, async (tx) => {
          await tx.magicLinkToken.create({
            data: {
              tenantId: session.user.tenantId,
              email,
              tokenHash: hashToken(token),
              purpose: "first_time_signup",
              expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
            },
          });
          // Look up gym name for the email subject inside the same transaction.
          return tx.tenant.findUnique({
            where: { id: session.user.tenantId },
            select: { name: true },
          });
        });
        inviteUrl = buildInviteUrl(req, token);
        await sendEmail({
          tenantId: session.user.tenantId,
          templateId: "invite_member",
          to: email,
          vars: {
            memberName: member.name,
            gymName: tenant?.name ?? "your gym",
            link: inviteUrl,
          },
        });
      } catch (e) {
        // Token / email failure must not break the member creation flow.
        // The owner still gets back the new Member row; inviteUrl will be null
        // and they can resend the invite later from the member detail page.
        console.error("[members.POST] invite token / email failed", e);
      }
    }

    return NextResponse.json({ ...member, inviteUrl }, { status: 201 });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A member with that email already exists" }, { status: 409 });
    }
    return apiError("Failed to create member", 500, e, "[members.POST]");
  }
}
