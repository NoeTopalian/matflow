import { put, get } from "@vercel/blob";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isTenantBlobUrl } from "@/lib/blob-url";
import { withTenantContext } from "@/lib/prisma-tenant";
import { readUploadBytes } from "@/lib/import-upload";

/**
 * Where an uploaded import CSV lives between upload, preview and commit.
 *
 * Production and previews: Vercel Blob, private, random-suffixed, kept with
 * its ImportJob. Local rehearsals have no Blob token, and without a fallback the real
 * upload → preview → commit path could never run anywhere but production, so a
 * migration rehearsal had to substitute the upload. When — and only when — the
 * deployment is not production AND TESTING_MODE is on, the file is kept in the
 * OS temp directory instead, addressed as `local-import://<name>`.
 *
 * Third scheme, `db-upload://<uploadId>` (3 Oct 2026): a file the browser sent
 * in chunks into private Postgres storage and the server verified by size and
 * sha256 (lib/import-upload.ts). It never touches the filesystem, has no
 * TESTING_MODE dependency and works in production. Reading it needs the
 * tenant, because it is read through `withTenantContext`.
 */

const LOCAL_PREFIX = "local-import://";
export const DB_UPLOAD_PREFIX = "db-upload://";
const LOCAL_DIR = path.join(os.tmpdir(), "matflow-imports");

function localAllowed(): boolean {
  return process.env.VERCEL_ENV !== "production" && process.env.TESTING_MODE === "true";
}

export function importStorageAvailable(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN || localAllowed();
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function putImportFile(tenantId: string, bytes: Uint8Array): Promise<string> {
  const name = `${tenantId}-${randomBytes(12).toString("hex")}.csv`;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`tenants/${tenantId}/imports/${name}`, Buffer.from(bytes), {
      access: "private",
      contentType: "text/csv",
      addRandomSuffix: true,
    });
    return blob.url;
  }
  if (!localAllowed()) throw new Error("File uploads not configured");
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, name), bytes);
  return `${LOCAL_PREFIX}${name}`;
}

function dbUploadRef(url: string, tenantId: string | undefined): { id: string; tenantId: string } {
  if (!tenantId) throw new Error("A tenant is required to read an uploaded import file");
  return { id: url.slice(DB_UPLOAD_PREFIX.length), tenantId };
}

/** The file's text, or null when it is gone. `tenantId` is required for `db-upload://`. */
export async function readImportFile(url: string, tenantId?: string): Promise<string | null> {
  if (url.startsWith(DB_UPLOAD_PREFIX)) {
    const ref = dbUploadRef(url, tenantId);
    const bytes = await withTenantContext(ref.tenantId, (tx) => readUploadBytes(tx, ref.tenantId, ref.id), { timeout: 45_000, maxWait: 10_000 });
    return bytes === null ? null : new TextDecoder("utf-8").decode(bytes);
  }
  if (url.startsWith(LOCAL_PREFIX)) {
    if (!localAllowed()) throw new Error("Local import storage is not available here");
    const name = path.basename(url.slice(LOCAL_PREFIX.length));
    try {
      return await fs.readFile(path.join(LOCAL_DIR, name), "utf8");
    } catch {
      return null;
    }
  }
  const blob = await get(url, { access: "private" });
  if (!blob) return null;
  if (blob.statusCode !== 200) throw new Error(`Failed to fetch file (${blob.statusCode})`);
  return new Response(blob.stream).text();
}

// No delete. An uploaded import file is kept with its ImportJob, private, for
// as long as the club uses MatFlow (product rule, Noe, 6 Nov 2026: "nothing
// should be automatically deleted"). A club's written erasure request removes
// it with the club (lib/tenant-purge.ts).

/**
 * A stored import file's raw bytes, or null when it is gone. Used by a member's
 * erasure (lib/importers/import-erasure.ts), which must see the file exactly as
 * stored (its encoding, a BOM). A chunked upload is read whatever its state —
 * attached to a job or never used.
 */
export async function readImportFileBytes(url: string, tenantId: string): Promise<Uint8Array | null> {
  if (url.startsWith(DB_UPLOAD_PREFIX)) {
    const ref = dbUploadRef(url, tenantId);
    const chunks = await withTenantContext(ref.tenantId, (tx) =>
      tx.importUploadChunk.findMany({ where: { uploadId: ref.id, tenantId: ref.tenantId }, orderBy: { index: "asc" }, select: { bytes: true } }),
      { timeout: 45_000, maxWait: 10_000 },
    );
    return chunks.length === 0 ? null : Buffer.concat(chunks.map((c) => c.bytes));
  }
  if (url.startsWith(LOCAL_PREFIX)) {
    if (!localAllowed()) throw new Error("Local import storage is not available here");
    const name = path.basename(url.slice(LOCAL_PREFIX.length));
    try {
      return await fs.readFile(path.join(LOCAL_DIR, name));
    } catch {
      return null;
    }
  }
  if (!isTenantBlobUrl(url, tenantId)) return null;
  const blob = await get(url, { access: "private" });
  if (!blob) return null;
  if (blob.statusCode !== 200) throw new Error(`Failed to fetch file (${blob.statusCode})`);
  return new Uint8Array(await new Response(blob.stream).arrayBuffer());
}

/**
 * Replace a stored import file's content IN PLACE (same address). Used ONLY by
 * a member's erasure (lib/importers/import-erasure.ts), to take that member's
 * rows out of a kept file. A Blob file is overwritten at its own pathname, so
 * no job is repointed and a failure leaves the old content — never a job
 * pointing at a deleted file.
 */
export async function rewriteImportFile(url: string, tenantId: string, bytes: Uint8Array): Promise<void> {
  const data = Buffer.from(bytes);
  if (url.startsWith(DB_UPLOAD_PREFIX)) {
    const ref = dbUploadRef(url, tenantId);
    await withTenantContext(ref.tenantId, async (tx) => {
      const upload = await tx.importUpload.findFirst({ where: { id: ref.id, tenantId: ref.tenantId }, select: { id: true, chunkSize: true } });
      if (!upload) throw new Error("The uploaded import file was not found");
      const count = Math.max(1, Math.ceil(data.length / upload.chunkSize));
      await tx.importUploadChunk.deleteMany({ where: { uploadId: upload.id, tenantId: ref.tenantId } });
      await tx.importUploadChunk.createMany({
        data: Array.from({ length: count }, (_, index) => {
          const part = data.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize);
          return { uploadId: upload.id, tenantId: ref.tenantId, index, bytes: part, sha256: sha256(part) };
        }),
      });
      await tx.importUpload.updateMany({
        where: { id: upload.id, tenantId: ref.tenantId },
        data: { expectedBytes: data.length, expectedSha256: sha256(data), chunkCount: count },
      });
    }, { timeout: 45_000, maxWait: 10_000 });
    return;
  }
  if (url.startsWith(LOCAL_PREFIX)) {
    if (!localAllowed()) throw new Error("Local import storage is not available here");
    const name = path.basename(url.slice(LOCAL_PREFIX.length));
    await fs.writeFile(path.join(LOCAL_DIR, name), data);
    return;
  }
  if (!isTenantBlobUrl(url, tenantId)) throw new Error("The import file is not in this club's store");
  const pathname = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  const written = await put(pathname, data, { access: "private", contentType: "text/csv", addRandomSuffix: false, allowOverwrite: true });
  if (written.url !== url) throw new Error("The import file was not rewritten at its own address");
}