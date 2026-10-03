/**
 * Chunked import uploads (lib/import-upload.ts) on the REAL test database —
 * the Neon test branch, never production (tests/setup-test-db.ts refuses the
 * production endpoint). Round-trips a 2.3 MiB file through create → put each
 * chunk → complete → claim → read, proves byte-for-byte equality and sha256,
 * and proves another club cannot read it: by the tenant filter always, and by
 * RLS too when the connection does not bypass it (run with the restricted
 * role, e.g. RESTRICTED_DATABASE_URL, for that half to execute).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("chunked import upload — real database", () => {
  let tenantA = "";
  let tenantB = "";
  let ownerA = "";
  let connectionBypassesRls = true;

  beforeAll(async () => {
    const { prisma } = await import("@/lib/prisma");
    const { withRlsBypass } = await import("@/lib/prisma-tenant");
    const [{ bypass }] = await prisma.$queryRawUnsafe<{ bypass: boolean }[]>(
      `SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    connectionBypassesRls = bypass;
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: "Upload Test A", slug: `upload-test-a-${STAMP}` } });
      const b = await tx.tenant.create({ data: { name: "Upload Test B", slug: `upload-test-b-${STAMP}` } });
      const u = await tx.user.create({
        data: { tenantId: a.id, email: `owner-${STAMP}@upload.test`, passwordHash: "x", name: "Owner A", role: "owner" },
      });
      tenantA = a.id;
      tenantB = b.id;
      ownerA = u.id;
    });
  });

  afterAll(async () => {
    const { withRlsBypass } = await import("@/lib/prisma-tenant");
    const ids = [tenantA, tenantB].filter(Boolean);
    if (ids.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.importUploadChunk.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.importUpload.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.user.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    });
  });

  it("round-trips 2.3 MiB byte-for-byte, claims once, and is invisible to another club", async () => {
    const { withTenantContext } = await import("@/lib/prisma-tenant");
    const up = await import("@/lib/import-upload");
    const { readImportFile, deleteImportFile, DB_UPLOAD_PREFIX } = await import("@/lib/import-storage");

    const size = Math.floor(2.3 * 1024 * 1024);
    const file = Buffer.alloc(size);
    for (let i = 0; i < size; i++) file[i] = 32 + ((i * 7919) % 95); // printable ASCII, so the text read is exact too
    const sha256 = createHash("sha256").update(file).digest("hex");

    const created = await withTenantContext(tenantA, (tx) =>
      up.createUpload(tx, { tenantId: tenantA, userId: ownerA, purpose: "attendance", fileName: "bookings.csv", bytes: size, sha256 }),
    );
    if (!created.ok) throw new Error(created.error);
    expect(created.chunkCount).toBe(3);

    for (let i = 0; i < created.chunkCount; i++) {
      const out = await withTenantContext(tenantA, (tx) =>
        up.putChunk(tx, {
          tenantId: tenantA, userId: ownerA, uploadId: created.id, token: created.token, index: i,
          bytes: file.subarray(i * up.CHUNK_SIZE, (i + 1) * up.CHUNK_SIZE),
        }),
      );
      expect(out.ok, `chunk ${i}`).toBe(true);
    }
    // Idempotent re-send of the last chunk.
    const resend = await withTenantContext(tenantA, (tx) =>
      up.putChunk(tx, { tenantId: tenantA, userId: ownerA, uploadId: created.id, token: created.token, index: 2, bytes: file.subarray(2 * up.CHUNK_SIZE) }),
    );
    expect(resend.ok).toBe(true);

    // Another club, holding the token, still cannot touch it.
    const foreignPut = await withTenantContext(tenantB, (tx) =>
      up.putChunk(tx, { tenantId: tenantB, userId: ownerA, uploadId: created.id, token: created.token, index: 0, bytes: file.subarray(0, up.CHUNK_SIZE) }),
    );
    expect(foreignPut.ok === false && foreignPut.code).toBe("not_found");

    const done = await withTenantContext(tenantA, (tx) =>
      up.completeUpload(tx, { tenantId: tenantA, userId: ownerA, uploadId: created.id, token: created.token }),
    );
    expect(done).toMatchObject({ ok: true, bytes: size, sha256 });

    const claim = await withTenantContext(tenantA, (tx) =>
      up.claimUpload(tx, { tenantId: tenantA, userId: ownerA, uploadId: created.id, purpose: "attendance" }),
    );
    expect(claim).toMatchObject({ ok: true, bytes: size, sha256, fileName: "bookings.csv" });
    const again = await withTenantContext(tenantA, (tx) =>
      up.claimUpload(tx, { tenantId: tenantA, userId: ownerA, uploadId: created.id, purpose: "attendance" }),
    );
    expect(again.ok).toBe(false);

    const bytes = await withTenantContext(tenantA, (tx) => up.readUploadBytes(tx, tenantA, created.id));
    expect(bytes).not.toBeNull();
    expect(Buffer.compare(bytes!, file)).toBe(0);
    expect(createHash("sha256").update(bytes!).digest("hex")).toBe(sha256);

    // The storage scheme the import API reads.
    const url = `${DB_UPLOAD_PREFIX}${created.id}`;
    expect(await readImportFile(url, tenantA)).toBe(file.toString("utf8"));
    expect(await readImportFile(url, tenantB)).toBeNull();
    await expect(readImportFile(url)).rejects.toThrow(/tenant/);

    // Tenant filter: another club reads nothing.
    expect(await withTenantContext(tenantB, (tx) => up.readUploadBytes(tx, tenantB, created.id))).toBeNull();
    // RLS: another club's context sees no rows even without a tenant filter.
    const unfiltered = await withTenantContext(tenantB, async (tx) => ({
      uploads: await tx.importUpload.count({ where: { id: created.id } }),
      chunks: await tx.importUploadChunk.count({ where: { uploadId: created.id } }),
    }));
    if (connectionBypassesRls) {
      console.log("connection bypasses RLS: the RLS half is not provable here (tenant filter proven above)");
    } else {
      expect(unfiltered).toEqual({ uploads: 0, chunks: 0 });
    }

    // Every chunk row carries the tenant (the RLS column).
    const { withRlsBypass } = await import("@/lib/prisma-tenant");
    const chunkTenants = await withRlsBypass((tx) =>
      tx.importUploadChunk.findMany({ where: { uploadId: created.id }, select: { tenantId: true } }),
    );
    expect(chunkTenants.map((c) => c.tenantId)).toEqual([tenantA, tenantA, tenantA]);

    await deleteImportFile(url, tenantA);
    expect(await readImportFile(url, tenantA)).toBeNull();
    const left = await withRlsBypass((tx) => tx.importUploadChunk.count({ where: { uploadId: created.id } }));
    expect(left).toBe(0);
  }, 180_000);
});
