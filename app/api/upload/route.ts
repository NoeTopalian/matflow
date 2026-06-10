import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import sharp from "sharp";
import { auth } from "@/auth";
import { requireOwner } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

if (process.env.NODE_ENV !== "production" && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.warn(
    "[upload] BLOB_READ_WRITE_TOKEN is not set — every upload request will return 503. " +
    "Provision a Vercel Blob store and copy the token into .env.",
  );
}

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_PIC_SIZE_PX = 256;

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
 * feat/member-profile-pictures Track A Phase A2: authorise an upload based
 * on its declared purpose. Returns either the authenticated context or a
 * NextResponse with an error status to bail out with.
 *
 * Branding / "" / unknown purpose → owner-only (legacy behaviour).
 * Profile-pic uploads → the caller must be:
 *   - a staff role in the same tenant as the target member, OR
 *   - the member themselves (session.user.memberId === targetMemberId).
 */
async function authoriseUpload(
  purpose: string | null,
  targetMemberId: string | null,
): Promise<
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; response: NextResponse }
> {
  if (purpose !== "profile-pic") {
    // Legacy branding / announcement-image / waiver-graphic uploads stay
    // owner-only. Routes that need looser auth call with purpose=profile-pic.
    const ctx = await requireOwner();
    return { ok: true, tenantId: ctx.tenantId, userId: ctx.userId };
  }

  const session = await auth();
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (!targetMemberId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "profile-pic uploads require targetMemberId" },
        { status: 400 },
      ),
    };
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const callerMemberId = (session.user as { memberId?: string }).memberId ?? null;
  const callerRole = session.user.role;
  const isStaff = STAFF_ROLES.includes(callerRole as (typeof STAFF_ROLES)[number]);
  const isSelf = callerMemberId !== null && callerMemberId === targetMemberId;

  if (!isStaff && !isSelf) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "You can only upload a profile picture for your own account." },
        { status: 403 },
      ),
    };
  }

  // Verify the target member belongs to this tenant — defence in depth so a
  // staff session in tenant A can't smuggle a Member id from tenant B.
  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: targetMemberId, tenantId },
      select: { id: true },
    }),
  );
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Member not found in this gym" }, { status: 404 }),
    };
  }

  return { ok: true, tenantId, userId };
}

export async function POST(req: Request) {
  // CSRF guard. multipart/form-data is a "simple" content type that browsers
  // send cross-origin without a CORS preflight, so this route is reachable
  // from a malicious page's <form> POST without the user's consent. The
  // codebase's CSRF helper inspects Origin/Referer headers and rejects
  // cross-origin requests. (Security audit 2026-05-07, severity MEDIUM.)
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const url = new URL(req.url);
  const purpose = url.searchParams.get("purpose");

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart payload" }, { status: 400 });
  }

  const targetMemberId =
    typeof formData.get("targetMemberId") === "string"
      ? (formData.get("targetMemberId") as string)
      : null;

  const authz = await authoriseUpload(purpose, targetMemberId);
  if (!authz.ok) return authz.response;
  const { tenantId, userId } = authz;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "File uploads are not configured. Set BLOB_READ_WRITE_TOKEN." },
      { status: 503 },
    );
  }

  try {
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 2MB)" }, { status: 400 });
    if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const validator = MAGIC_BYTES[file.type];
    if (!validator || !validator(head)) {
      return NextResponse.json({ error: "File contents do not match the declared image type" }, { status: 400 });
    }

    const id = randomBytes(12).toString("hex");

    // feat/member-profile-pictures Track A Phase A2: profile-pic uploads
    // are downscaled to 256×256 cover-crop WebP @ q80 BEFORE hitting Vercel
    // Blob. A 2 MB phone-camera shot becomes ~8 KB at that resolution.
    // The downscale also strips EXIF — drops geo + camera metadata that
    // an attacker could harvest from a public blob URL.
    let uploadBuffer: Buffer | File = file;
    let uploadContentType = file.type;
    let uploadExt = EXT_FOR_TYPE[file.type] ?? "png";
    let processedSizeBytes = file.size;
    let processedDimensions: { width: number; height: number } | null = null;

    if (purpose === "profile-pic") {
      const raw = Buffer.from(await file.arrayBuffer());
      try {
        const out = await sharp(raw)
          .rotate() // honour EXIF orientation before stripping metadata
          .resize(PROFILE_PIC_SIZE_PX, PROFILE_PIC_SIZE_PX, { fit: "cover" })
          .webp({ quality: 80 })
          .toBuffer();
        uploadBuffer = out;
        uploadContentType = "image/webp";
        uploadExt = "webp";
        processedSizeBytes = out.length;
        processedDimensions = { width: PROFILE_PIC_SIZE_PX, height: PROFILE_PIC_SIZE_PX };
      } catch (e) {
        // sharp throws on truncated / hostile image data even after the
        // magic-byte check passes. Treat as a 400 since the bytes are
        // structurally invalid — never crash the route.
        console.warn("[upload] sharp resize failed", e);
        return NextResponse.json(
          { error: "Image could not be processed. Try a different file." },
          { status: 400 },
        );
      }
    }

    const filename = `tenants/${tenantId}/${id}.${uploadExt}`;
    const blob = await put(filename, uploadBuffer, {
      access: "private",
      contentType: uploadContentType,
      addRandomSuffix: true,
    });

    // For profile-pic, authoriseUpload guarantees targetMemberId is non-null
    // (it returns 400 otherwise). The non-null assertion captures that invariant.
    const auditEntityId =
      purpose === "profile-pic" ? (targetMemberId as string) : tenantId;
    await logAudit({
      tenantId,
      userId,
      action: purpose === "profile-pic" ? "member.profile_picture.upload" : "upload.image",
      entityType: purpose === "profile-pic" ? "Member" : "Tenant",
      entityId: auditEntityId,
      metadata: {
        purpose: purpose ?? "branding",
        contentType: uploadContentType,
        originalBytes: file.size,
        sizeBytes: processedSizeBytes,
        dimensions: processedDimensions,
        url: blob.url,
        targetMemberId: targetMemberId ?? undefined,
      },
      req,
    });

    return NextResponse.json(
      { url: blob.url },
      { headers: { "X-Content-Type-Options": "nosniff" } },
    );
  } catch (e) {
    // Surface the underlying Blob error to Vercel logs / Sentry so the cause
    // (invalid token, store quota, network) is debuggable instead of opaque.
    // SettingsPage falls back to a data: URL when this fails (resilience),
    // but the owner still needs to know what to fix in Vercel.
    console.error("[upload] Vercel Blob put failed", e);
    const message = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
