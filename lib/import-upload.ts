import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { constantTimeEq } from "@/lib/constant-time";

/**
 * Chunked, verified, private import uploads (3 Oct 2026).
 *
 * A real TeamUp attendance export is 4,508,479 bytes; sent as one multipart
 * body it exceeds the hosting platform's 4.5 MB request-body limit, so the
 * single-request upload could never work in production. The browser now sends
 * the file in 1 MiB chunks into private Postgres storage (ImportUpload +
 * ImportUploadChunk), the server verifies the reassembled file by size and
 * sha256, and the import API is handed only a reference (`db-upload://<id>`,
 * lib/import-storage.ts) that it claims once.
 *
 * Every helper takes the caller's tenant-scoped transaction
 * (`withTenantContext(tenantId, (tx) => …)`), filters on tenantId itself, and
 * writes tenantId onto every chunk row (the RLS column). Refusals are returned,
 * never thrown, so a route can map them to a status without try/catch.
 */

type Tx = Prisma.TransactionClient;

export const CHUNK_SIZE = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const ALLOWED_PURPOSES = ["attendance"] as const;
export type UploadPurpose = (typeof ALLOWED_PURPOSES)[number];

const FILE_NAME_MAX = 200;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type UploadRefusalCode = "invalid" | "not_found" | "expired" | "conflict";
export type UploadRefusal = {
  ok: false;
  code: UploadRefusalCode;
  error: string;
  /** Machine-readable detail for a 409 (complete / claim). */
  reason?: string;
  missing?: number[];
};

/** HTTP status for each refusal. not_found deliberately covers "not yours" too. */
export const UPLOAD_REFUSAL_STATUS: Record<UploadRefusalCode, number> = {
  invalid: 400,
  not_found: 404,
  expired: 410,
  conflict: 409,
};

const refuse = (code: UploadRefusalCode, error: string, extra?: Partial<UploadRefusal>): UploadRefusal => ({
  ok: false,
  code,
  error,
  ...extra,
});

const NOT_FOUND = () => refuse("not_found", "Upload not found");
const EXPIRED = () => refuse("expired", "This upload has expired. Choose the file again.");

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function chunkCountFor(bytes: number, chunkSize = CHUNK_SIZE): number {
  return Math.ceil(bytes / chunkSize);
}

/** Length chunk `index` must have: chunkSize, except the last, which carries the remainder. */
export function expectedChunkLength(index: number, totalBytes: number, chunkSize: number, chunkCount: number): number {
  return index < chunkCount - 1 ? chunkSize : totalBytes - chunkSize * (chunkCount - 1);
}

type UploadRow = {
  id: string;
  tenantId: string;
  createdById: string;
  purpose: string;
  fileName: string;
  expectedBytes: number;
  expectedSha256: string;
  chunkSize: number;
  chunkCount: number;
  tokenHash: string;
  status: string;
  expiresAt: Date;
};

/** The upload, if it is in this tenant, was made by this user, and the token matches. */
async function findOwnedUpload(
  tx: Tx,
  args: { tenantId: string; userId: string; uploadId: string; token: string },
): Promise<UploadRow | null> {
  if (!args.uploadId || !args.token) return null;
  const upload = (await tx.importUpload.findFirst({
    where: { id: args.uploadId, tenantId: args.tenantId },
  })) as UploadRow | null;
  if (!upload) return null;
  // The token comparison runs whatever the creator check says, so a wrong
  // user and a wrong token cost the same.
  const tokenOk = constantTimeEq(hashToken(args.token), upload.tokenHash);
  if (!tokenOk || upload.createdById !== args.userId) return null;
  return upload;
}

export async function createUpload(
  tx: Tx,
  args: { tenantId: string; userId: string; purpose: string; fileName: string; bytes: number; sha256: string },
): Promise<
  | { ok: true; id: string; token: string; chunkSize: number; chunkCount: number; expiresAt: Date }
  | UploadRefusal
> {
  if (!(ALLOWED_PURPOSES as readonly string[]).includes(args.purpose)) return refuse("invalid", "Invalid upload purpose");
  if (!Number.isInteger(args.bytes) || args.bytes < 1) return refuse("invalid", "The file is empty");
  if (args.bytes > MAX_UPLOAD_BYTES) return refuse("invalid", "File too large (max 25MB)");
  if (typeof args.sha256 !== "string" || !SHA256_HEX.test(args.sha256)) return refuse("invalid", "Invalid file checksum");
  const trimmed = typeof args.fileName === "string" ? args.fileName.trim() : "";
  if (!trimmed.toLowerCase().endsWith(".csv")) return refuse("invalid", "Only CSV files are supported");
  // Truncated to 200, keeping the extension the check above relied on.
  const fileName = trimmed.length > FILE_NAME_MAX ? `${trimmed.slice(0, FILE_NAME_MAX - 4)}.csv` : trimmed;

  const token = randomBytes(32).toString("base64url");
  const chunkCount = chunkCountFor(args.bytes);
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
  const row = await tx.importUpload.create({
    data: {
      tenantId: args.tenantId,
      createdById: args.userId,
      purpose: args.purpose,
      fileName,
      expectedBytes: args.bytes,
      expectedSha256: args.sha256,
      chunkSize: CHUNK_SIZE,
      chunkCount,
      tokenHash: hashToken(token),
      status: "open",
      expiresAt,
    },
    select: { id: true },
  });
  return { ok: true, id: row.id, token, chunkSize: CHUNK_SIZE, chunkCount, expiresAt };
}

export async function putChunk(
  tx: Tx,
  args: { tenantId: string; userId: string; uploadId: string; token: string; index: number; bytes: Uint8Array },
): Promise<{ ok: true; index: number; sha256: string } | UploadRefusal> {
  const upload = await findOwnedUpload(tx, args);
  if (!upload) return NOT_FOUND();
  if (upload.status !== "open") return refuse("conflict", "This upload is already complete", { reason: "not_open" });
  if (upload.expiresAt.getTime() <= Date.now()) return EXPIRED();
  if (!Number.isInteger(args.index) || args.index < 0 || args.index >= upload.chunkCount) {
    return refuse("invalid", "Chunk index out of range");
  }
  const expected = expectedChunkLength(args.index, upload.expectedBytes, upload.chunkSize, upload.chunkCount);
  if (args.bytes.length !== expected) {
    return refuse("invalid", `Chunk ${args.index} must be ${expected} bytes; received ${args.bytes.length}`);
  }

  const sha256 = createHash("sha256").update(args.bytes).digest("hex");
  const bytes = Uint8Array.from(args.bytes);
  // Upsert: a chunk re-sent after a dropped response simply replaces itself.
  await tx.importUploadChunk.upsert({
    where: { uploadId_index: { uploadId: upload.id, index: args.index } },
    create: { uploadId: upload.id, tenantId: args.tenantId, index: args.index, bytes, sha256 },
    update: { tenantId: args.tenantId, bytes, sha256 },
  });
  return { ok: true, index: args.index, sha256 };
}

export async function completeUpload(
  tx: Tx,
  args: { tenantId: string; userId: string; uploadId: string; token: string },
): Promise<
  | { ok: true; id: string; purpose: string; bytes: number; sha256: string; chunkCount: number }
  | UploadRefusal
> {
  const upload = await findOwnedUpload(tx, args);
  if (!upload) return NOT_FOUND();
  const done = { ok: true as const, id: upload.id, purpose: upload.purpose, bytes: upload.expectedBytes, sha256: upload.expectedSha256, chunkCount: upload.chunkCount };
  // A retried "complete" whose first response was lost is answered the same way.
  if (upload.status === "complete") return done;
  if (upload.status !== "open") return refuse("conflict", "This upload has already been used", { reason: "consumed" });
  if (upload.expiresAt.getTime() <= Date.now()) return EXPIRED();

  const chunks = await tx.importUploadChunk.findMany({
    where: { uploadId: upload.id, tenantId: args.tenantId },
    orderBy: { index: "asc" },
    select: { index: true, bytes: true },
  });
  const present = new Set(chunks.map((c) => c.index));
  const missing: number[] = [];
  for (let i = 0; i < upload.chunkCount; i++) if (!present.has(i)) missing.push(i);
  if (missing.length > 0) {
    return refuse("conflict", `The upload is missing ${missing.length} part(s). Send them again.`, { reason: "missing_chunks", missing });
  }
  const total = chunks.reduce((n, c) => n + c.bytes.length, 0);
  if (total !== upload.expectedBytes) {
    return refuse("conflict", "The file did not arrive at the expected size. Send it again.", { reason: "size_mismatch" });
  }
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c.bytes);
  if (hash.digest("hex") !== upload.expectedSha256) {
    return refuse("conflict", "The file did not arrive intact (checksum mismatch). Send it again.", { reason: "hash_mismatch" });
  }

  const res = await tx.importUpload.updateMany({
    where: { id: upload.id, tenantId: args.tenantId, status: "open" },
    data: { status: "complete", completedAt: new Date() },
  });
  if (res.count === 0) return refuse("conflict", "The upload changed while it was being verified. Try again.", { reason: "raced" });
  return done;
}

/**
 * Hand a verified upload to one import job. The conditional update is the
 * claim: of two concurrent claims exactly one moves complete → consumed.
 */
export async function claimUpload(
  tx: Tx,
  args: { tenantId: string; userId: string; uploadId: string; purpose: string },
): Promise<{ ok: true; id: string; fileName: string; bytes: number; sha256: string } | UploadRefusal> {
  if (!args.uploadId) return NOT_FOUND();
  const upload = (await tx.importUpload.findFirst({
    where: { id: args.uploadId, tenantId: args.tenantId },
  })) as UploadRow | null;
  if (!upload || upload.createdById !== args.userId) return NOT_FOUND();
  if (upload.purpose !== args.purpose) return refuse("invalid", "This upload was not made for this import");
  if (upload.status === "consumed") return refuse("conflict", "This upload has already been used", { reason: "consumed" });
  if (upload.status !== "complete") return refuse("conflict", "This upload has not finished", { reason: "not_complete" });
  const now = new Date();
  if (upload.expiresAt.getTime() <= now.getTime()) return EXPIRED();

  const res = await tx.importUpload.updateMany({
    where: {
      id: upload.id,
      tenantId: args.tenantId,
      createdById: args.userId,
      purpose: args.purpose,
      status: "complete",
      expiresAt: { gt: now },
    },
    data: { status: "consumed" },
  });
  if (res.count === 0) return refuse("conflict", "This upload has already been used", { reason: "consumed" });
  return { ok: true, id: upload.id, fileName: upload.fileName, bytes: upload.expectedBytes, sha256: upload.expectedSha256 };
}

/**
 * The verified file, reassembled in index order, or null when it is gone or
 * was never verified (an open upload's bytes are not a file yet).
 */
export async function readUploadBytes(tx: Tx, tenantId: string, uploadId: string): Promise<Buffer | null> {
  if (!uploadId) return null;
  const upload = await tx.importUpload.findFirst({
    where: { id: uploadId, tenantId },
    select: { id: true, status: true, chunkCount: true, expectedBytes: true },
  });
  if (!upload || (upload.status !== "complete" && upload.status !== "consumed")) return null;
  const chunks = await tx.importUploadChunk.findMany({
    where: { uploadId: upload.id, tenantId },
    orderBy: { index: "asc" },
    select: { bytes: true },
  });
  if (chunks.length !== upload.chunkCount) return null;
  const out = Buffer.concat(chunks.map((c) => c.bytes));
  return out.length === upload.expectedBytes ? out : null;
}

export async function deleteUpload(tx: Tx, tenantId: string, uploadId: string): Promise<number> {
  // Chunks cascade from the upload; deleted explicitly too so the delete does
  // not depend on the FK action.
  await tx.importUploadChunk.deleteMany({ where: { uploadId, tenantId } });
  const res = await tx.importUpload.deleteMany({ where: { id: uploadId, tenantId } });
  return res.count;
}
