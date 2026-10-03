/**
 * Chunked, verified, private import uploads (lib/import-upload.ts) against an
 * in-memory database. A real TeamUp attendance export is 4,508,479 bytes —
 * over the platform's 4.5 MB body limit as one request — so it travels as
 * 1 MiB chunks, is verified by size and sha256, and is claimed by one job.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  CHUNK_SIZE,
  MAX_UPLOAD_BYTES,
  chunkCountFor,
  claimUpload,
  completeUpload,
  createUpload,
  deleteUpload,
  expectedChunkLength,
  putChunk,
  readUploadBytes,
} from "@/lib/import-upload";
import { makeFakeUploadDb } from "./import-upload-fake";

const T = "tenant-a";
const U = "owner-a";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fileOf(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) % 251;
  return b;
}

let db: ReturnType<typeof makeFakeUploadDb>;
beforeEach(() => {
  db = makeFakeUploadDb();
});

async function open(file: Uint8Array, overrides: Partial<{ fileName: string; purpose: string; sha256: string }> = {}) {
  const out = await createUpload(db.tx, {
    tenantId: T, userId: U, purpose: "attendance", fileName: "attendance.csv", bytes: file.length, sha256: sha(file), ...overrides,
  });
  if (!out.ok) throw new Error(out.error);
  return out;
}

async function sendAll(file: Uint8Array, up: { id: string; token: string; chunkCount: number }) {
  for (let i = 0; i < up.chunkCount; i++) {
    const r = await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: i, bytes: file.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
    expect(r.ok).toBe(true);
  }
}

describe("createUpload", () => {
  it("counts the real 4,508,479-byte TeamUp export as 5 chunks, the last carrying the remainder", async () => {
    expect(chunkCountFor(4_508_479)).toBe(5);
    expect(expectedChunkLength(4, 4_508_479, CHUNK_SIZE, 5)).toBe(4_508_479 - 4 * CHUNK_SIZE);
    const out = await createUpload(db.tx, { tenantId: T, userId: U, purpose: "attendance", fileName: "a.csv", bytes: 4_508_479, sha256: "a".repeat(64) });
    expect(out.ok && out.chunkCount).toBe(5);
    expect(out.ok && out.chunkSize).toBe(CHUNK_SIZE);
  });

  it("stores only the token's hash, never the token", async () => {
    const out = await open(fileOf(10));
    expect(out.token.length).toBeGreaterThanOrEqual(43);
    expect(db.uploads[0].tokenHash).toBe(sha(new TextEncoder().encode(out.token)));
    expect(JSON.stringify(db.uploads)).not.toContain(out.token);
  });

  it("refuses a bad purpose, size, checksum or file name", async () => {
    const base = { tenantId: T, userId: U, purpose: "attendance", fileName: "a.csv", bytes: 10, sha256: "b".repeat(64) };
    for (const bad of [
      { purpose: "members" },
      { bytes: 0 },
      { bytes: MAX_UPLOAD_BYTES + 1 },
      { bytes: 1.5 },
      { sha256: "B".repeat(64) },
      { sha256: "b".repeat(63) },
      { fileName: "a.xlsx" },
      { fileName: "   " },
    ]) {
      const out = await createUpload(db.tx, { ...base, ...bad });
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      if (!out.ok) expect(out.code).toBe("invalid");
    }
    expect(db.uploads).toHaveLength(0);
  });

  it("trims the name and truncates it to 200 characters keeping .csv (case-insensitive)", async () => {
    await open(fileOf(5), { fileName: `  ${"x".repeat(300)}.CSV  ` });
    expect(db.uploads[0].fileName).toHaveLength(200);
    expect(db.uploads[0].fileName.endsWith(".csv")).toBe(true);
  });
});

describe("putChunk", () => {
  it("accepts full chunks and a last-chunk remainder, and refuses any other length", async () => {
    const file = fileOf(CHUNK_SIZE * 2 + 123);
    const up = await open(file);
    expect(up.chunkCount).toBe(3);
    const short = await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 0, bytes: file.subarray(0, CHUNK_SIZE - 1) });
    expect(short.ok === false && short.code).toBe("invalid");
    const lastTooLong = await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 2, bytes: file.subarray(0, 124) });
    expect(lastTooLong.ok === false && lastTooLong.code).toBe("invalid");
    const last = await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 2, bytes: file.subarray(CHUNK_SIZE * 2) });
    expect(last.ok).toBe(true);
    expect(db.chunks[0]).toMatchObject({ tenantId: T, index: 2, sha256: sha(file.subarray(CHUNK_SIZE * 2)) });
  });

  it("refuses an out-of-range index", async () => {
    const up = await open(fileOf(10));
    for (const index of [-1, 1, 0.5]) {
      const r = await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index, bytes: fileOf(10) });
      expect(r.ok === false && r.code).toBe("invalid");
    }
  });

  it("answers not_found for a wrong token, another user, or another tenant", async () => {
    const file = fileOf(10);
    const up = await open(file);
    const attempts = [
      { tenantId: T, userId: U, token: up.token + "x" },
      { tenantId: T, userId: U, token: "" },
      { tenantId: T, userId: "owner-b", token: up.token },
      { tenantId: "tenant-b", userId: U, token: up.token },
    ];
    for (const a of attempts) {
      const r = await putChunk(db.tx, { ...a, uploadId: up.id, index: 0, bytes: file });
      expect(r.ok === false && r.code, JSON.stringify(a)).toBe("not_found");
    }
    expect(db.chunks).toHaveLength(0);
  });

  it("refuses an expired upload", async () => {
    const file = fileOf(10);
    const up = await open(file);
    db.uploads[0].expiresAt = new Date(Date.now() - 1);
    const r = await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 0, bytes: file });
    expect(r.ok === false && r.code).toBe("expired");
  });

  it("takes an idempotent re-send: the chunk is replaced, not duplicated", async () => {
    const file = fileOf(10);
    const up = await open(file);
    await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 0, bytes: fileOf(10).fill(0) });
    await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 0, bytes: file });
    expect(db.chunks).toHaveLength(1);
    const done = await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token });
    expect(done.ok).toBe(true);
  });
});

describe("completeUpload", () => {
  it("refuses a missing chunk and leaves the upload open for a re-send", async () => {
    const file = fileOf(CHUNK_SIZE + 5);
    const up = await open(file);
    await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 1, bytes: file.subarray(CHUNK_SIZE) });
    const r = await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toMatchObject({ code: "conflict", reason: "missing_chunks", missing: [0] });
    expect(db.uploads[0].status).toBe("open");
    await putChunk(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token, index: 0, bytes: file.subarray(0, CHUNK_SIZE) });
    expect((await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token })).ok).toBe(true);
  });

  it("refuses a file whose hash does not match the declared sha256", async () => {
    const file = fileOf(100);
    const up = await open(file, { sha256: sha(fileOf(99)) });
    await sendAll(file, up);
    const r = await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token });
    expect(r.ok === false && r.reason).toBe("hash_mismatch");
    expect(db.uploads[0].status).toBe("open");
  });

  it("verifies a multi-chunk file and marks it complete", async () => {
    const file = fileOf(CHUNK_SIZE * 2 + 77);
    const up = await open(file);
    await sendAll(file, up);
    const r = await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token });
    expect(r).toMatchObject({ ok: true, bytes: file.length, sha256: sha(file), chunkCount: 3 });
    expect(db.uploads[0].status).toBe("complete");
    expect(db.uploads[0].completedAt).toBeInstanceOf(Date);
  });

  it("answers not_found to a wrong token", async () => {
    const file = fileOf(10);
    const up = await open(file);
    await sendAll(file, up);
    const r = await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: "nope" });
    expect(r.ok === false && r.code).toBe("not_found");
  });
});

describe("claimUpload / readUploadBytes / deleteUpload", () => {
  it("claims once: a second claim is refused; the bytes read back exactly", async () => {
    const file = fileOf(CHUNK_SIZE + 999);
    const up = await open(file);
    await sendAll(file, up);
    // Not complete yet: cannot be claimed or read.
    expect((await claimUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, purpose: "attendance" })).ok).toBe(false);
    expect(await readUploadBytes(db.tx, T, up.id)).toBeNull();
    await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token });

    expect((await claimUpload(db.tx, { tenantId: T, userId: "owner-b", uploadId: up.id, purpose: "attendance" })).ok).toBe(false);
    expect((await claimUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, purpose: "members" })).ok).toBe(false);
    const first = await claimUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, purpose: "attendance" });
    expect(first).toMatchObject({ ok: true, id: up.id, fileName: "attendance.csv", bytes: file.length, sha256: sha(file) });
    const second = await claimUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, purpose: "attendance" });
    expect(second.ok === false && second.code).toBe("conflict");

    const bytes = await readUploadBytes(db.tx, T, up.id);
    expect(bytes && Buffer.compare(bytes, Buffer.from(file))).toBe(0);
    expect(await readUploadBytes(db.tx, "tenant-b", up.id)).toBeNull();

    expect(await deleteUpload(db.tx, "tenant-b", up.id)).toBe(0);
    expect(await deleteUpload(db.tx, T, up.id)).toBe(1);
    expect(db.chunks).toHaveLength(0);
    expect(await readUploadBytes(db.tx, T, up.id)).toBeNull();
  });

  it("refuses to claim an expired upload", async () => {
    const file = fileOf(10);
    const up = await open(file);
    await sendAll(file, up);
    await completeUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, token: up.token });
    db.uploads[0].expiresAt = new Date(Date.now() - 1);
    const r = await claimUpload(db.tx, { tenantId: T, userId: U, uploadId: up.id, purpose: "attendance" });
    expect(r.ok === false && r.code).toBe("expired");
  });
});
