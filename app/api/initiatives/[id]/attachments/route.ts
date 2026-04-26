import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];
const MAX_BYTES = 10 * 1024 * 1024;

const MAGIC_BYTES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  "application/pdf": (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
};

const EXT_FOR_TYPE: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "application/pdf": "pdf",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id: initiativeId } = await params;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "File uploads not configured" }, { status: 503 });
  }

  const initiative = await prisma.initiative.findFirst({ where: { id: initiativeId, tenantId } });
  if (!initiative) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const validator = MAGIC_BYTES[file.type];
    if (!validator || !validator(head)) {
      return NextResponse.json({ error: "File contents do not match the declared type" }, { status: 400 });
    }

    const ext = EXT_FOR_TYPE[file.type] ?? "bin";
    const cuid = randomBytes(12).toString("hex");
    const filename = `tenants/${tenantId}/initiatives/${initiativeId}/${cuid}.${ext}`;

    const blob = await put(filename, file, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: true,
    });

    const attachment = await prisma.initiativeAttachment.create({
      data: {
        initiativeId,
        blobUrl: blob.url,
        filename: file.name.slice(0, 200),
        mimeType: file.type,
        sizeBytes: file.size,
      },
    });

    await logAudit({
      tenantId,
      userId,
      action: "initiative.attachment.add",
      entityType: "InitiativeAttachment",
      entityId: attachment.id,
      metadata: { initiativeId, filename: attachment.filename, mimeType: attachment.mimeType },
      req,
    });

    return NextResponse.json(attachment, {
      status: 201,
      headers: { "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id: initiativeId } = await params;
  const { searchParams } = new URL(req.url);
  const attachmentId = searchParams.get("attachmentId");
  if (!attachmentId) return NextResponse.json({ error: "attachmentId required" }, { status: 400 });

  const initiative = await prisma.initiative.findFirst({ where: { id: initiativeId, tenantId } });
  if (!initiative) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });

  try {
    await prisma.initiativeAttachment.deleteMany({ where: { id: attachmentId, initiativeId } });
    await logAudit({
      tenantId,
      userId,
      action: "initiative.attachment.remove",
      entityType: "InitiativeAttachment",
      entityId: attachmentId,
      metadata: { initiativeId },
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove attachment" }, { status: 500 });
  }
}
