import { auth } from "@/auth";
import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "File uploads are not configured. Set BLOB_READ_WRITE_TOKEN." },
      { status: 503 },
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 2MB)" }, { status: 400 });
    if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

    const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "png";
    const filename = `tenants/${session.user.tenantId}/logo-${Date.now()}.${ext}`;

    const blob = await put(filename, file, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: false,
    });

    return NextResponse.json({ url: blob.url });
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
