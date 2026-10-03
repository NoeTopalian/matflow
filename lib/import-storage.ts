import { put, get, del } from "@vercel/blob";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTenantContext } from "@/lib/prisma-tenant";
import { deleteUpload, readUploadBytes } from "@/lib/import-upload";

/**
 * Where an uploaded import CSV lives between upload, preview and commit.
 *
 * Production and previews: Vercel Blob, private, random-suffixed, deleted after
 * commit. Local rehearsals have no Blob token, and without a fallback the real
 * upload → preview → commit path could never run anywhere but production, so a
 * migration rehearsal had to substitute the upload. When — and only when — the
 * deployment is not production AND TESTING_MODE is on, the file is kept in the
 * OS temp directory instead, addressed as `local-import://<name>`.
 *
 * Third scheme, `db-upload://<uploadId>` (3 Oct 2026): a file the browser sent
 * in chunks into private Postgres storage and the server verified by size and
 * sha256 (lib/import-upload.ts). It never touches the filesystem, has no
 * TESTING_MODE dependency and works in production. Reading or deleting it
 * needs the tenant, because it is read through `withTenantContext`.
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
  if (!tenantId) throw new Error("A tenant is required to read or delete an uploaded import file");
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

export async function deleteImportFile(url: string, tenantId?: string): Promise<void> {
  if (url.startsWith(DB_UPLOAD_PREFIX)) {
    const ref = dbUploadRef(url, tenantId);
    await withTenantContext(ref.tenantId, (tx) => deleteUpload(tx, ref.tenantId, ref.id));
    return;
  }
  if (url.startsWith(LOCAL_PREFIX)) {
    const name = path.basename(url.slice(LOCAL_PREFIX.length));
    await fs.rm(path.join(LOCAL_DIR, name), { force: true });
    return;
  }
  await del(url);
}
