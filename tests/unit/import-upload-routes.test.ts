/**
 * The chunked import upload routes (app/api/admin/import/uploads/**) with the
 * REAL auth gate (lib/api-authz.ts, session mocked) and the REAL same-origin
 * check (lib/csrf.ts); the database is the in-memory fake. Proves: 401 / 403
 * for no session, a non-owner and a sign-in still owing its authenticator
 * code; a cross-origin request refused; an oversized declared chunk refused
 * with 413 before the body is read; a wrong token answered 404; and that no
 * response ever carries the file's bytes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { makeFakeUploadDb } from "./import-upload-fake";

const h = vi.hoisted(() => ({
  session: null as unknown,
  db: null as unknown as { tx: never },
  audit: [] as unknown[],
}));

vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: never) => Promise<T>) => fn(h.db.tx),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async (a: unknown) => { h.audit.push(a); } }));
vi.mock("@/lib/api-error", async () => {
  const { NextResponse } = await import("next/server");
  return {
    apiError: (message: string, status: number, e?: unknown) => {
      if (e) console.error(e);
      return NextResponse.json({ ok: false, error: message }, { status });
    },
  };
});

import { POST as create } from "@/app/api/admin/import/uploads/route";
import { PUT as putChunkRoute } from "@/app/api/admin/import/uploads/[id]/chunks/[index]/route";
import { POST as complete } from "@/app/api/admin/import/uploads/[id]/complete/route";
import { CHUNK_SIZE } from "@/lib/import-upload";

const ORIGIN = "http://localhost:3000";
const owner = { user: { id: "u-owner", tenantId: "t1", role: "owner" } };
const CONTENT = new TextEncoder().encode("Customer Name,Email\nSecret Person,secret.person@example.com\n");
const sha = createHash("sha256").update(CONTENT).digest("hex");

const responses: unknown[] = [];
async function body(res: Response) {
  const json = await res.json();
  responses.push(json);
  return json as Record<string, unknown>;
}

function createReq(origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/admin/import/uploads`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "attendance", fileName: "bookings.csv", bytes: CONTENT.length, sha256: sha }),
  });
}
function chunkReq(token: string, bytes: Uint8Array) {
  return new Request(`${ORIGIN}/api/admin/import/uploads/x/chunks/0`, {
    method: "PUT",
    headers: { origin: ORIGIN, "content-type": "application/octet-stream", "x-upload-token": token },
    body: Uint8Array.from(bytes),
  });
}
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  h.session = owner;
  h.db = makeFakeUploadDb() as unknown as { tx: never };
  h.audit = [];
});

describe("chunked import upload routes — gates", () => {
  it("401 without a session", async () => {
    h.session = null;
    expect((await create(createReq())).status).toBe(401);
  });

  it("403 for a non-owner", async () => {
    h.session = { user: { ...owner.user, role: "manager" } };
    expect((await create(createReq())).status).toBe(403);
  });

  it("403 while the sign-in still owes its authenticator code", async () => {
    h.session = { user: { ...owner.user, totpPending: true } };
    expect((await create(createReq())).status).toBe(403);
  });

  it("refuses a cross-origin request on every route", async () => {
    expect((await create(createReq("https://evil.example"))).status).toBe(403);
    const evil = { origin: "https://evil.example", "x-upload-token": "t" };
    expect((await putChunkRoute(new Request(`${ORIGIN}/x`, { method: "PUT", headers: evil, body: "a" }), params({ id: "up1", index: "0" }))).status).toBe(403);
    expect((await complete(new Request(`${ORIGIN}/x`, { method: "POST", headers: evil }), params({ id: "up1" }))).status).toBe(403);
  });
});

describe("chunked import upload routes — contract", () => {
  it("creates, takes the chunk, verifies, and never returns the bytes", async () => {
    const res = await create(createReq());
    expect(res.status).toBe(201);
    const created = await body(res);
    expect(created).toMatchObject({ uploadId: "up1", chunkSize: CHUNK_SIZE, chunkCount: 1 });
    expect(typeof created.token).toBe("string");
    expect(typeof created.expiresAt).toBe("string");

    const put = await putChunkRoute(chunkReq(created.token as string, CONTENT), params({ id: "up1", index: "0" }));
    expect(put.status).toBe(200);
    expect(await body(put)).toEqual({ index: 0, received: true });

    const done = await complete(
      new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "x-upload-token": created.token as string } }),
      params({ id: "up1" }),
    );
    expect(done.status).toBe(200);
    expect(await body(done)).toEqual({ uploadId: "up1", bytes: CONTENT.length, sha256: sha });

    // Audit rows: create + complete, sha prefix only, no content.
    expect(h.audit).toHaveLength(2);
    const auditText = JSON.stringify(h.audit);
    expect(auditText).not.toContain(sha);
    expect(auditText).toContain(sha.slice(0, 12));

    const all = JSON.stringify(responses) + auditText;
    expect(all).not.toContain("Secret Person");
    expect(all).not.toContain("secret.person");
    expect(all).not.toContain(Buffer.from(CONTENT).toString("base64").slice(0, 24));
  });

  it("413 on an oversized declared Content-Length without reading the body", async () => {
    const created = await body(await create(createReq()));
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const req = {
      method: "PUT",
      headers: new Headers({ origin: ORIGIN, "content-length": String(CHUNK_SIZE + 1025), "x-upload-token": created.token as string }),
      arrayBuffer,
    } as unknown as Request;
    const res = await putChunkRoute(req, params({ id: "up1", index: "0" }));
    expect(res.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("413 on a body longer than one chunk even without a declared length", async () => {
    const created = await body(await create(createReq()));
    const res = await putChunkRoute(chunkReq(created.token as string, new Uint8Array(CHUNK_SIZE + 1)), params({ id: "up1", index: "0" }));
    expect(res.status).toBe(413);
  });

  it("404 for a wrong token, a missing token, or another user's upload", async () => {
    const created = await body(await create(createReq()));
    expect((await putChunkRoute(chunkReq("wrong-token", CONTENT), params({ id: "up1", index: "0" }))).status).toBe(404);
    expect((await putChunkRoute(chunkReq("", CONTENT), params({ id: "up1", index: "0" }))).status).toBe(404);
    h.session = { user: { ...owner.user, id: "u-other-owner" } };
    expect((await putChunkRoute(chunkReq(created.token as string, CONTENT), params({ id: "up1", index: "0" }))).status).toBe(404);
    h.session = { user: { ...owner.user, tenantId: "t2" } };
    expect((await putChunkRoute(chunkReq(created.token as string, CONTENT), params({ id: "up1", index: "0" }))).status).toBe(404);
  });

  it("400 for a wrong length or index; 409 with a reason when completing too early", async () => {
    const created = await body(await create(createReq()));
    const token = created.token as string;
    expect((await putChunkRoute(chunkReq(token, CONTENT.subarray(1)), params({ id: "up1", index: "0" }))).status).toBe(400);
    expect((await putChunkRoute(chunkReq(token, CONTENT), params({ id: "up1", index: "1" }))).status).toBe(400);
    expect((await putChunkRoute(chunkReq(token, CONTENT), params({ id: "up1", index: "abc" }))).status).toBe(400);
    const early = await complete(
      new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "x-upload-token": token } }),
      params({ id: "up1" }),
    );
    expect(early.status).toBe(409);
    expect(await body(early)).toMatchObject({ reason: "missing_chunks", missing: [0] });
  });
});
