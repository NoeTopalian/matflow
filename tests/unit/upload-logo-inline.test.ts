import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import sharp from "sharp";
import { isAcceptableLogoUrl } from "@/lib/logo-url";

// T9b (17 Oct 2026, Q9 E-9 (a)): a club logo is shown with no session on the
// login page, kiosk, leaderboard and public club page. Blob uploads are
// private and /api/blob-image needs a session, so a blob logo is blank there.
// /api/upload?purpose=logo therefore NEVER calls put(): the logo is stored as
// an inline raster data: URL, even when a Blob token is configured. Every
// other purpose keeps the private-Blob path.

vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { putMock, requireApiOwnerMock, logAuditMock } = vi.hoisted(() => ({
  putMock: vi.fn(),
  requireApiOwnerMock: vi.fn(),
  logAuditMock: vi.fn(),
}));
vi.mock("@vercel/blob", () => ({ put: putMock, del: vi.fn() }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: requireApiOwnerMock }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

import { POST } from "@/app/api/upload/route";

let PNG_BYTES: Uint8Array;
let BIG_PNG_BYTES: Uint8Array;

beforeAll(async () => {
  PNG_BYTES = new Uint8Array(
    await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .toBuffer(),
  );
  BIG_PNG_BYTES = new Uint8Array(
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .png()
      .toBuffer(),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  putMock.mockResolvedValue({ url: "https://abc.private.blob.vercel-storage.com/tenants/tenant-X/x.webp" });
  requireApiOwnerMock.mockResolvedValue({
    ok: true,
    session: {} as unknown,
    tenantId: "tenant-X",
    userId: "user-1",
    role: "owner",
  });
  logAuditMock.mockResolvedValue(undefined);
});

function req(bytes: Uint8Array, query = "?purpose=logo") {
  const fd = new FormData();
  fd.append("file", new File([bytes as BlobPart], "logo.png", { type: "image/png" }));
  return new Request(`http://localhost/api/upload${query}`, { method: "POST", body: fd });
}

describe("POST /api/upload?purpose=logo", () => {
  it("never calls put(), even with a Blob token configured, and returns a raster data: URL", async () => {
    const res = await POST(req(PNG_BYTES));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(putMock).not.toHaveBeenCalled();
    expect(url.startsWith("data:image/webp;base64,")).toBe(true);
    // The value the upload returns is one the settings route will accept.
    expect(isAcceptableLogoUrl(url, "tenant-X")).toBe(true);
  });

  it("is owner-only: the owner gate decides before anything is stored", async () => {
    const { NextResponse } = await import("next/server");
    requireApiOwnerMock.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const res = await POST(req(PNG_BYTES));
    expect(res.status).toBe(403);
    expect(putMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("downscales a large logo so the inline value stays small (longest edge 512px)", async () => {
    const res = await POST(req(BIG_PNG_BYTES));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const bytes = Buffer.from(url.slice("data:image/webp;base64,".length), "base64");
    const meta = await sharp(bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(512);
  });

  it("audits the upload as an inline logo with no URL in the row", async () => {
    await POST(req(PNG_BYTES));
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const entry = logAuditMock.mock.calls[0][0] as { metadata: Record<string, unknown>; entityType: string };
    expect(entry.entityType).toBe("Tenant");
    expect(entry.metadata.purpose).toBe("logo");
    expect(entry.metadata.storage).toBe("inline");
    expect(entry.metadata.url).toBe("[inline-data-url]");
  });

  it("leaves other owner uploads on the private-Blob path", async () => {
    const res = await POST(req(PNG_BYTES, ""));
    expect(res.status).toBe(200);
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2]).toMatchObject({ access: "private" });
  });
});
