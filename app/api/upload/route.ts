import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireOwner } from "@/lib/authz";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

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

export async function POST(req: Request) {
  const { tenantId } = await requireOwner();

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

    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const validator = MAGIC_BYTES[file.type];
    if (!validator || !validator(head)) {
      return NextResponse.json({ error: "File contents do not match the declared image type" }, { status: 400 });
    }

    const ext = EXT_FOR_TYPE[file.type] ?? "png";
    const id = randomBytes(12).toString("hex");
    const filename = `tenants/${tenantId}/${id}.${ext}`;

    const blob = await put(filename, file, {
      access: "public",
      contentType: file.type,
      addRandomSuffix: true,
    });

    return NextResponse.json(
      { url: blob.url },
      { headers: { "X-Content-Type-Options": "nosniff" } },
    );
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
