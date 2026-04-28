import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import type { ImportSource } from "@/lib/importers";
import { apiError } from "@/lib/api-error";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_SOURCES: ImportSource[] = ["generic", "mindbody", "glofox", "wodify"];

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwner();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "File uploads not configured" }, { status: 503 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const source = String(formData.get("source") ?? "generic") as ImportSource;
    if (!ALLOWED_SOURCES.includes(source)) return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });

    // Accept text/csv or text/plain (some browsers send the latter for .csv)
    if (!["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"].includes(file.type) && !file.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "Only CSV files are supported" }, { status: 400 });
    }

    const cuid = randomBytes(12).toString("hex");
    const blob = await put(`tenants/${tenantId}/imports/${cuid}.csv`, file, {
      access: "public",
      contentType: "text/csv",
      addRandomSuffix: true,
    });

    const job = await prisma.importJob.create({
      data: {
        tenantId,
        createdById: userId,
        source,
        fileName: file.name.slice(0, 200),
        fileBlobUrl: blob.url,
        status: "pending",
      },
    });

    await logAudit({
      tenantId,
      userId,
      action: "import.upload",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { source, fileName: job.fileName, sizeBytes: file.size },
      req,
    });

    return NextResponse.json(job, { status: 201 });
  } catch (e) {
    return apiError("Import upload failed", 500, e, "[admin/import/upload]");
  }
}
