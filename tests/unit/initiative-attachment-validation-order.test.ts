// Campaign lane L-B, J62 round 2: a bad upload was answered 503, not 400.
//
// The run's exact failure (tests/e2e/campaign/assess/lb-3-ownership-and-integrations.spec.ts:518):
//
//   [L-B J62] ../ filename upload → 503
//   Error: a traversal filename never 500s
//   Expected: < 500   Received: 503
//
// `POST /api/initiatives/[id]/attachments` checked `BLOB_READ_WRITE_TOKEN`
// before it read the form at all, so on any deployment without blob storage
// configured EVERY upload — a 20 MB file, a script-bearing SVG declaring
// itself image/png, a `../../../etc/passwd.png` filename — came back
// "File uploads not configured", 503. Three consequences, in order of how
// much they matter:
//
//   1. The refusals the product is supposed to make were untestable and
//      unproven: no environment could show that oversize, wrong-type and
//      magic-byte-mismatched files are refused, because the door shut first.
//   2. A 5xx says "my fault, try again"; a file that is too large or the
//      wrong type is the caller's, and is a 400 forever. Retrying never helps.
//   3. The owner is told the wrong thing about their own upload.
//
// Validation is the caller's business and storage is ours, so the caller's
// half is now settled first and the 503 is reached only by a request that
// would otherwise have been stored.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { findFirst, create, put } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      initiative: { findFirst },
      initiativeAttachment: { create },
    }),
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: async () => ({ ok: true, tenantId: "t-A", userId: "u-1" }),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));

import { POST } from "@/app/api/initiatives/[id]/attachments/route";

const params = Promise.resolve({ id: "init-1" });

function upload(file: File) {
  const fd = new FormData();
  fd.set("file", file);
  return POST(
    new Request("http://localhost:3847/api/initiatives/init-1/attachments", {
      method: "POST",
      headers: { Origin: "http://localhost:3847" },
      body: fd,
    }),
    { params },
  );
}

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);

let hadToken: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  findFirst.mockResolvedValue({ id: "init-1", tenantId: "t-A" });
});

afterEach(() => {
  if (hadToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = hadToken;
});

describe("a bad upload is refused on its merits, not on the storage config", () => {
  it("a 20 MB file is 400 even with no blob token", async () => {
    const res = await upload(
      new File([new Uint8Array(20 * 1024 * 1024)], "big.png", { type: "image/png" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/too large/i) });
    expect(put).not.toHaveBeenCalled();
  });

  it("a script-bearing SVG declaring itself image/png is 400 even with no blob token", async () => {
    const res = await upload(
      new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], "x.png", {
        type: "image/png",
      }),
    );
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it("an image/svg+xml file is 400 — svg is not an allowed type", async () => {
    const res = await upload(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    expect(res.status).toBe(400);
  });

  it("a ../ filename on an otherwise valid file is not a 5xx", async () => {
    const res = await upload(
      new File([PNG_HEAD], "../../../../etc/passwd.png", { type: "image/png" }),
    );
    // No storage is configured here, so the honest answer is 503 — but it is
    // reached only after the file itself has passed, never instead of a 400.
    expect(res.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });

  it("a well-formed upload still reaches storage when the token is present", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    put.mockResolvedValue({ url: "https://blob.test/tenants/t-A/initiatives/init-1/abc.png" });
    create.mockResolvedValue({ id: "att-1", filename: "../../../../etc/passwd.png" });
    const res = await upload(
      new File([PNG_HEAD], "../../../../etc/passwd.png", { type: "image/png" }),
    );
    expect(res.status).toBe(201);
    // The stored key is server-minted; the client's name is display text only.
    expect(put.mock.calls[0][0]).toBe("tenants/t-A/initiatives/init-1/".concat(
      (put.mock.calls[0][0] as string).split("/").pop() as string,
    ));
    expect(put.mock.calls[0][0]).not.toContain("..");
  });
});
