/**
 * An in-memory stand-in for the two Prisma delegates lib/import-upload.ts uses
 * (ImportUpload, ImportUploadChunk). Shared by import-upload.test.ts and
 * import-upload-routes.test.ts. Supports exactly the where-shapes the module
 * sends: equality on columns, and `{ gt: Date }`.
 */

export type FakeUpload = {
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
  completedAt: Date | null;
  createdAt: Date;
};
export type FakeChunk = { uploadId: string; tenantId: string; index: number; bytes: Uint8Array; sha256: string };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date) && "gt" in (v as object)) {
      return (row[k] as Date).getTime() > ((v as { gt: Date }).gt).getTime();
    }
    return row[k] === v;
  });
}

export function makeFakeUploadDb() {
  const uploads: FakeUpload[] = [];
  const chunks: FakeChunk[] = [];
  const tx = {
    importUpload: {
      create: async ({ data }: { data: Omit<FakeUpload, "id" | "completedAt" | "createdAt"> }) => {
        const row: FakeUpload = { id: `up${uploads.length + 1}`, completedAt: null, createdAt: new Date(), ...data };
        uploads.push(row);
        return { id: row.id };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = uploads.find((u) => matches(u as unknown as Record<string, unknown>, where));
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeUpload> }) => {
        let count = 0;
        for (const u of uploads) {
          if (matches(u as unknown as Record<string, unknown>, where)) {
            Object.assign(u, data);
            count++;
          }
        }
        return { count };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const gone = uploads.filter((u) => matches(u as unknown as Record<string, unknown>, where));
        for (const g of gone) uploads.splice(uploads.indexOf(g), 1);
        return { count: gone.length };
      },
    },
    importUploadChunk: {
      upsert: async ({ where, create, update }: {
        where: { uploadId_index: { uploadId: string; index: number } };
        create: FakeChunk;
        update: Partial<FakeChunk>;
      }) => {
        const key = where.uploadId_index;
        const existing = chunks.find((c) => c.uploadId === key.uploadId && c.index === key.index);
        if (existing) Object.assign(existing, update);
        else chunks.push({ ...create });
        return {};
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        chunks
          .filter((c) => matches(c as unknown as Record<string, unknown>, where))
          .sort((a, b) => a.index - b.index)
          .map((c) => ({ index: c.index, bytes: Buffer.from(c.bytes) })),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const gone = chunks.filter((c) => matches(c as unknown as Record<string, unknown>, where));
        for (const g of gone) chunks.splice(chunks.indexOf(g), 1);
        return { count: gone.length };
      },
    },
  };
  return { uploads, chunks, tx: tx as never };
}
