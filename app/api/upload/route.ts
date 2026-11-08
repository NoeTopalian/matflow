import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import sharp from "sharp";
import { auth } from "@/auth";
import { requireApiOwner } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { apiError } from "@/lib/api-error";
import { z } from "zod";
import { checkUploadRateLimit, formFields, refuseOversizeBody } from "@/lib/upload-guard";

if (process.env.NODE_ENV !== "production" && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.warn(
    "[upload] BLOB_READ_WRITE_TOKEN is not set — every upload request will return 503. " +
    "Provision a Vercel Blob store and copy the token into .env.",
  );
}

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
// Ingress cap — defence in depth for anything that bypasses the browser. It
// governs only what may be SENT: every accepted image is re-encoded below to a
// bounded WebP, so it never decides what is KEPT. At 2MB it refused essentially
// every phone photo, which is what broke mobile uploads. Clients downscale
// first (lib/downscale-image.ts), so a real upload now arrives far below this.
// Do NOT raise it further: Vercel's serverless request-body limit is ~4.5MB, so
// a larger cap would fail at the platform with an opaque error before this code
// ever runs.
// 4, not 6. Vercel's serverless request-body limit is ~4.5MB and the PLATFORM
// enforces it: a 5MB upload is rejected with an opaque 413 before this route
// runs, so a 6MB cap advertised a size the product could never accept and
// swallowed the friendly message with it. Sitting below the platform limit
// means every rejection this route can still see is one it can explain.
const MAX_UPLOAD_MB = 4;
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
// 512, not 256: the avatar renders at 96 CSS px = 288 device px at DPR 3, so a
// 256px stored image was upscaled by the browser. See AVATAR_MAX_EDGE_PX.
const PROFILE_PIC_SIZE_PX = 512;
// Non-avatar images (member photos, branding, announcements) are downscaled so
// the longest edge is ≤ this. Keeps the inline-data-URL fallback bounded.
const MAX_IMAGE_EDGE_PX = 1600;
// Club logos (purpose=logo, T9b) are stored inline as a data: URL on the
// Tenant row and travel in every branding payload (login, kiosk, leaderboard,
// public club page), so they are kept small. The largest logo renders at about
// 160 CSS px tall = 480 device px at DPR 3; 512 covers it.
const LOGO_MAX_EDGE_PX = 512;
/**
 * The club logo purpose. Owner-only (it is not member-scoped), and NEVER
 * written to Vercel Blob: the store is private and /api/blob-image needs a
 * session, so a blob logo is blank on every anonymous surface. Always inline.
 */
const LOGO_PURPOSE = "logo";

const STAFF_ROLES = ["owner", "manager", "coach", "admin"] as const;

const MAGIC_BYTES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

const EXT_FOR_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

/**
 * feat/member-profile-pictures Track A Phase A2: the upload policy by declared
 * purpose (enforced by uploadPrincipal + authoriseMemberTarget below).
 *
 * Branding / "" / unknown purpose → owner-only (legacy behaviour).
 * Profile-pic uploads → the caller must be:
 *   - a staff role in the same tenant as the target member, OR
 *   - the member themselves (session.user.memberId === targetMemberId).
 */
// Member-scoped upload purposes: the caller may be staff in the member's
// tenant OR the member themselves. Everything else (branding, announcement,
// waiver graphics) stays owner-only.
const MEMBER_SCOPED_PURPOSES = ["profile-pic", "member-photo"];

/**
 * Who is uploading, decided BEFORE the body is read (security campaign
 * iteration 2, lane C2): the principal identifies the rate-limit buckets, so a
 * refused or throttled caller never makes the server parse a multipart body or
 * decode an image. Owner-only purposes run the owner gate here; member-scoped
 * purposes need a session here and the target-member check after the body.
 */
type Principal =
  | { ok: true; tenantId: string; userId: string; memberScoped: false }
  | { ok: true; tenantId: string; userId: string; memberScoped: true; callerMemberId: string | null; isStaff: boolean }
  | { ok: false; response: NextResponse };

async function uploadPrincipal(purpose: string | undefined): Promise<Principal> {
  if (!MEMBER_SCOPED_PURPOSES.includes(purpose ?? "")) {
    // Legacy branding / announcement-image / waiver-graphic uploads stay
    // owner-only. Routes that need looser auth call with a member-scoped purpose.
    const gate = await requireApiOwner();
    if (!gate.ok) return gate;
    return { ok: true, tenantId: gate.tenantId, userId: gate.userId, memberScoped: false };
  }
  const session = await auth();
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const callerRole = session.user.role;
  return {
    ok: true,
    tenantId: session.user.tenantId,
    userId: session.user.id,
    memberScoped: true,
    callerMemberId: (session.user as { memberId?: string }).memberId ?? null,
    isStaff: STAFF_ROLES.includes(callerRole as (typeof STAFF_ROLES)[number]),
  };
}

/**
 * feat/member-profile-pictures Track A Phase A2: a member-scoped upload's
 * caller must be staff in the same tenant as the target member, OR the member
 * themselves (session.user.memberId === targetMemberId).
 */
async function authoriseMemberTarget(
  p: Extract<Principal, { memberScoped: true }>,
  targetMemberId: string | null,
): Promise<NextResponse | null> {
  if (!targetMemberId) {
    return NextResponse.json({ error: "profile-pic uploads require targetMemberId" }, { status: 400 });
  }
  const isSelf = p.callerMemberId !== null && p.callerMemberId === targetMemberId;
  if (!p.isStaff && !isSelf) {
    return NextResponse.json({ error: "You can only upload a profile picture for your own account." }, { status: 403 });
  }
  // Verify the target member belongs to this tenant — defence in depth so a
  // staff session in tenant A can't smuggle a Member id from tenant B.
  const member = await withTenantContext(p.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: targetMemberId, tenantId: p.tenantId },
      select: { id: true },
    }),
  );
  if (!member) return NextResponse.json({ error: "Member not found in this gym" }, { status: 404 });
  return null;
}

/** Query string: only `purpose` (lane C2 strict validation). */
const querySchema = z.strictObject({ purpose: z.string().regex(/^[a-z-]{1,32}$/).optional() });
/**
 * Multipart fields. `file` is required (checked below for a clearer message);
 * `targetMemberId` for member-scoped purposes; `prefix` is sent by the
 * announcement composer and is ignored. Anything else is refused.
 */
const formSchema = z.strictObject({
  file: z.unknown().optional(),
  targetMemberId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  prefix: z.string().max(32).optional(),
});

export async function POST(req: Request) {
  // CSRF guard. multipart/form-data is a "simple" content type that browsers
  // send cross-origin without a CORS preflight, so this route is reachable
  // from a malicious page's <form> POST without the user's consent. The
  // codebase's CSRF helper inspects Origin/Referer headers and rejects
  // cross-origin requests. (Security audit 2026-05-07, severity MEDIUM.)
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const url = new URL(req.url);
  const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success || url.searchParams.getAll("purpose").length > 1) {
    return NextResponse.json({ error: "Invalid upload request" }, { status: 400 });
  }
  const purpose = query.data.purpose ?? null;

  // Lane C2 order: declared size → who → rate limit → body → target → bytes.
  // Nothing below reads the body until the caller is known and within budget.
  const oversize = refuseOversizeBody(
    req,
    MAX_BYTES,
    `That image is too large. The limit is ${MAX_UPLOAD_MB}MB — try a smaller photo.`,
  );
  if (oversize) return oversize;

  const principal = await uploadPrincipal(purpose ?? undefined);
  if (!principal.ok) return principal.response;
  const { tenantId, userId } = principal;

  const limited = await checkUploadRateLimit("image", tenantId, userId);
  if (limited) return limited;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart payload" }, { status: 400 });
  }
  const fields = formFields(formData);
  const parsedForm = fields.ok ? formSchema.safeParse(fields.fields) : null;
  if (!parsedForm || !parsedForm.success) {
    return NextResponse.json({ error: "Invalid upload request" }, { status: 400 });
  }
  const targetMemberId = parsedForm.data.targetMemberId ?? null;

  if (principal.memberScoped) {
    const refused = await authoriseMemberTarget(principal, targetMemberId);
    if (refused) return refused;
  }

  try {
    const file = parsedForm.data.file;
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `That image is too large. The limit is ${MAX_UPLOAD_MB}MB — try a smaller photo.` },
        { status: 400 },
      );
    }
    if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const validator = MAGIC_BYTES[file.type];
    if (!validator || !validator(head)) {
      return NextResponse.json({ error: "File contents do not match the declared image type" }, { status: 400 });
    }

    const id = randomBytes(12).toString("hex");

    // Resize EVERY image to a bounded WebP before storage:
    //   - profile-pic → 256² cover-crop (~8 KB)
    //   - everything else → longest edge ≤ MAX_IMAGE_EDGE_PX (~100–300 KB)
    // This strips EXIF (geo/camera) and keeps the inline-data-URL fallback
    // small enough to store when Vercel Blob is unavailable.
    let uploadBuffer: Buffer = Buffer.from(await file.arrayBuffer());
    let uploadContentType = file.type;
    let uploadExt = EXT_FOR_TYPE[file.type] ?? "png";
    let processedSizeBytes = file.size;
    let processedDimensions: { width: number; height: number } | null = null;

    try {
      // Decoding cost is bounded (security lane D F4, SEC-051): 50 MP, not sharp's 268 MP default — an 8 KB PNG
      // decodes to 67 MP otherwise. A per-principal rate limit on this route is still owed (FINDINGS SF-40).
      const pipeline = sharp(uploadBuffer, { limitInputPixels: 50_000_000 }).rotate(); // honour EXIF orientation
      const resized =
        purpose === "profile-pic"
          ? pipeline.resize(PROFILE_PIC_SIZE_PX, PROFILE_PIC_SIZE_PX, { fit: "cover" })
          : purpose === LOGO_PURPOSE
            ? pipeline.resize(LOGO_MAX_EDGE_PX, LOGO_MAX_EDGE_PX, {
                fit: "inside",
                withoutEnlargement: true,
              })
            : pipeline.resize(MAX_IMAGE_EDGE_PX, MAX_IMAGE_EDGE_PX, {
                fit: "inside",
                withoutEnlargement: true,
              });
      const quality = purpose === "profile-pic" || purpose === LOGO_PURPOSE ? 92 : 82;
      const out = await resized.webp({ quality }).toBuffer();
      const meta = await sharp(out).metadata();
      uploadBuffer = out;
      uploadContentType = "image/webp";
      uploadExt = "webp";
      processedSizeBytes = out.length;
      processedDimensions =
        meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
    } catch (e) {
      // sharp throws on truncated / hostile image data even after the
      // magic-byte check passes. Treat as a 400 — never crash the route.
      console.warn("[upload] sharp resize failed", e);
      return NextResponse.json(
        { error: "Image could not be processed. Try a different file." },
        { status: 400 },
      );
    }

    // Store the resized bytes. Prefer Vercel Blob; if it's unconfigured or the
    // store rejects the write, fall back to an inline data: URL so uploads
    // never hard-fail. The resized WebP is small enough to inline, and every
    // consumer's URL validator accepts data:image/webp;base64 URLs.
    const filename = `tenants/${tenantId}/${id}.${uploadExt}`;
    const inlineUrl = () => `data:${uploadContentType};base64,${uploadBuffer.toString("base64")}`;
    let finalUrl: string;
    let storage: "blob" | "inline";
    if (purpose === LOGO_PURPOSE) {
      // T9b: a logo is public by design (login, kiosk, leaderboard, public
      // club page) and must render with no session, so it is never put() to
      // the private store. The bytes are the bounded WebP above.
      finalUrl = inlineUrl();
      storage = "inline";
    } else {
      try {
        if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN not set");
        const blob = await put(filename, uploadBuffer, {
          // Private (Bug 3): member faces and gym assets must not sit on a
          // public CDN URL. Rendering goes via /api/blob-image (auth-gated,
          // resolves a signed downloadUrl through head()).
          access: "private",
          contentType: uploadContentType,
          addRandomSuffix: true,
        });
        finalUrl = blob.url;
        storage = "blob";
      } catch (e) {
        console.warn(
          "[upload] Vercel Blob unavailable — storing inline data URL",
          e instanceof Error ? e.message : e,
        );
        finalUrl = inlineUrl();
        storage = "inline";
      }
    }

    const isMemberScoped = MEMBER_SCOPED_PURPOSES.includes(purpose ?? "");
    const auditEntityId = isMemberScoped && targetMemberId ? targetMemberId : tenantId;
    await logAudit({
      tenantId,
      userId,
      action: purpose === "profile-pic" ? "member.profile_picture.upload" : "upload.image",
      entityType: isMemberScoped ? "Member" : "Tenant",
      entityId: auditEntityId,
      metadata: {
        purpose: purpose ?? "branding",
        contentType: uploadContentType,
        originalBytes: file.size,
        sizeBytes: processedSizeBytes,
        dimensions: processedDimensions,
        storage, // "blob" | "inline" — lets us see in the audit log which path ran
        url: storage === "blob" ? finalUrl : "[inline-data-url]",
        targetMemberId: targetMemberId ?? undefined,
      },
      req,
    });

    return NextResponse.json(
      { url: finalUrl },
      { headers: { "X-Content-Type-Options": "nosniff" } },
    );
  } catch (e) {
    // Route through apiError so the client gets a generic message (never the
    // raw internal error.message) while Sentry + logs keep the real cause.
    return apiError("Upload failed", 500, e, "[upload]");
  }
}
