import { put, get, del } from "@vercel/blob";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Where an uploaded import CSV lives between upload, preview and commit.
 *
 * Production and previews: Vercel Blob, private, random-suffixed, deleted after
 * commit. Local rehearsals have no Blob token, and without a fallback the real
 * upload → preview → commit path could never run anywhere but production, so a
 * migration rehearsal had to substitute the upload. When — and only when — the
 * deployment is not production AND TESTING_MODE is on, the file is kept in the
 * OS temp directory instead, addressed as `local-import://<name>`.
 */

const LOCAL_PREFIX = "local-import://";
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

/** The file's text, or null when it is gone. */
export async function readImportFile(url: string): Promise<string | null> {
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

export async function deleteImportFile(url: string): Promise<void> {
  if (url.startsWith(LOCAL_PREFIX)) {
    const name = path.basename(url.slice(LOCAL_PREFIX.length));
    await fs.rm(path.join(LOCAL_DIR, name), { force: true });
    return;
  }
  await del(url);
}
