import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import sharp from "sharp";
import { auth } from "@/auth";
import { requireApiOwner } from "@/lib/api-authz";
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
// Ingress cap — defence in depth for anything that bypasses the browser. It
// governs only what may be SENT: every accepted image is re-encoded below to a
// bounded WebP, so it never decides what is KEPT. At 2MB it refused essentially
// every phone photo, which is what broke mobile uploads. Clients downscale
// first (lib/downscale-image.ts), so a real upload now arrives far below this.
// Do NOT raise it further: Vercel's serverless request-body limit is ~4.5MB, so
// a larger cap would fail at the platform with an opaque error before this code
// ever runs.
const MAX_UPLOAD_MB = 6;
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const PROFILE_PIC_SIZE_PX = 256;
// Non-avatar images (member photos, branding, announcements) are downscaled so
// the longest edge is ≤ this. Keeps the inline-data-URL fallback bounded.
const MAX_IMAGE_EDGE_PX = 1600;

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
// Member-scoped upload purposes: the caller may be staff in the member's
// tenant OR the member themselves. Everything else (branding, announcement,
// waiver graphics) stays owner-only.
const MEMBER_SCOPED_PURPOSES = ["profile-pic", "member-photo"];

async function authoriseUpload(
  purpose: string | null,
  targetMemberId: string | null,
): Promise<
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; response: NextResponse }
> {
  if (!MEMBER_SCOPED_PURPOSES.includes(purpose ?? "")) {
    // Legacy branding / announcement-image / waiver-graphic uploads stay
    // owner-only. Routes that need looser auth call with a member-scoped purpose.
    const gate = await requireApiOwner();
    if (!gate.ok) return gate;
    return { ok: true, tenantId: gate.tenantId, userId: gate.userId };
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

  try {
    const file = formData.get("file");
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
      const pipeline = sharp(uploadBuffer).rotate(); // honour EXIF orientation
      const resized =
        purpose === "profile-pic"
          ? pipeline.resize(PROFILE_PIC_SIZE_PX, PROFILE_PIC_SIZE_PX, { fit: "cover" })
          : pipeline.resize(MAX_IMAGE_EDGE_PX, MAX_IMAGE_EDGE_PX, {
              fit: "inside",
              withoutEnlargement: true,
            });
      const out = await resized.webp({ quality: purpose === "profile-pic" ? 80 : 82 }).toBuffer();
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
    let finalUrl: string;
    let storage: "blob" | "inline";
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
      finalUrl = `data:${uploadContentType};base64,${uploadBuffer.toString("base64")}`;
      storage = "inline";
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
    console.error("[upload] failed", e);
    const message = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
