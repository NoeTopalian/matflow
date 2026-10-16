/**
 * SF-40 / SEC-051 / SEC-073 / SEC-049 — upload controls on every multipart route (security campaign
 * iteration 2, lane C2, 9 Oct 2026). Bounded: each cell drives the real route handler with a fake
 * blob client (put is a mock — never a real Blob upload), sharp mocked (no decode), and the REAL
 * lib/rate-limit.ts over a fake RateLimitHit table (so the shared-DB path and the store-failure
 * path are both exercised as they run in production).
 *
 * Controls pinned: declared Content-Length refused before the body is read; per-user and per-tenant
 * budgets (429 + Retry-After, body unread, nothing decoded or stored); MIME sniffing versus the
 * declared type; SVG refused at upload and never served inline; strict multipart/query fields
 * (unknown or duplicated fields refused); client filenames normalised and never used as a key.
 * Red (evidence/C2/04-upload-red-green.log): against the HEAD route files these cells fail.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  hits: [] as Array<{ bucket: string; hitAt: Date }>,
  dbDown: false,
  principal: { tenantId: "tenant-c2", userId: "user-c2" },
  session: null as null | { user: Record<string, unknown> },
  sharpCalls: 0,
  put: [] as Array<{ path: string; contentType?: string }>,
  attachments: [] as Array<Record<string, unknown>>,
  importJobs: [] as Array<Record<string, unknown>>,
  emails: 0,
}));

vi.mock("@/lib/prisma", () => {
  const rateLimitHit = {
    groupBy: async ({ where }: { where: { bucket: string; hitAt: { gte: Date } } }) => {
      if (h.dbDown) throw new Error("connect ECONNREFUSED (secC2 fake)");
      const rows = h.hits.filter((x) => x.bucket === where.bucket && x.hitAt >= where.hitAt.gte);
      if (rows.length === 0) return [];
      return [{ bucket: where.bucket, _count: { _all: rows.length }, _min: { hitAt: rows.reduce((a, b) => (a.hitAt < b.hitAt ? a : b)).hitAt } }];
    },
    create: async ({ data }: { data: { bucket: string } }) => {
      if (h.dbDown) throw new Error("connect ECONNREFUSED (secC2 fake)");
      h.hits.push({ bucket: data.bucket, hitAt: new Date() });
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  };
  // Lane C3: the allowed path is now one transaction — advisory lock, then a conditional insert whose
  // interpolations are (bucket, windowMs, id, bucket, max). This fake gives it the same semantics so the
  // shared-table path (not the memory fallback) is what these cells exercise.
  const $executeRaw = (_s: TemplateStringsArray, ..._v: unknown[]) => ({ op: "lock" as const });
  const $queryRaw = (_s: TemplateStringsArray, ...v: unknown[]) => ({ op: "insert" as const, bucket: v[0] as string, windowMs: Number(v[1]), max: Number(v[4]) });
  type Op = { op: string; bucket?: string; windowMs?: number; max?: number };
  const $transaction = async (arg: Op[] | ((tx: unknown) => Promise<unknown>)) => {
    // SF-135 (lane L1): checkRateLimit runs the same two statements in an INTERACTIVE transaction now (its bounds are
    // owned there, not by Prisma's timer). The callback's statements are recorded as the same ops and answered by the
    // same rules; nothing asserted about them changes.
    const run = async (ops: Op[]) => {
      if (h.dbDown) throw new Error("connect ECONNREFUSED (secC2 fake)");
      return ops.map((o) => {
        if (o.op !== "insert") return 1;
        const since = Date.now() - o.windowMs!;
        const rows = h.hits.filter((x) => x.bucket === o.bucket && x.hitAt.getTime() >= since);
        const ok = rows.length < o.max!;
        if (ok) h.hits.push({ bucket: o.bucket!, hitAt: new Date() });
        const oldest = rows.reduce<number | null>((a, b) => (a === null || b.hitAt.getTime() < a ? b.hitAt.getTime() : a), null);
        return [{ count: rows.length, inserted: ok ? 1 : 0, oldestAgeMs: oldest === null ? null : Date.now() - oldest }];
      });
    };
    if (typeof arg !== "function") return run(arg);
    const recorded: Op[] = [];
    return arg({
      $executeRaw: async (q: TemplateStringsArray, ...v: unknown[]) => (recorded.push($executeRaw(q, ...v)), 1),
      $queryRaw: async (q: TemplateStringsArray, ...v: unknown[]) => {
        recorded.push($queryRaw(q, ...v));
        const out = (await run(recorded)) as unknown[];
        return out[out.length - 1];
      },
    });
  };
  return { prisma: { rateLimitHit, $executeRaw, $queryRaw, $transaction } };
});

const tx = {
  member: { findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => (where.id.startsWith("m-c2") ? { id: where.id } : null) },
  initiative: { findFirst: async () => ({ id: "init-c2" }) },
  initiativeAttachment: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `att-${h.attachments.length}`, ...data };
      h.attachments.push(row);
      return row;
    },
    deleteMany: async () => ({ count: 1 }),
  },
  importJob: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `job-${h.importJobs.length}`, createdAt: new Date(), ...data };
      h.importJobs.push(row);
      return row;
    },
    findFirst: async () => null,
  },
  tenant: { findUnique: async () => ({ name: "C2 Club", slug: "c2-club", timezone: "Europe/London" }) },
  user: { findUnique: async () => ({ name: "C2 Owner", email: "owner@c2.example" }) },
};
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, session: {}, role: "owner", ...h.principal }),
  requireApiOwnerOrManager: async () => ({ ok: true, session: {}, role: "owner", ...h.principal }),
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => { h.emails++; return { ok: true }; } }));
vi.mock("@/lib/email-delivery", () => ({ isEmailDeliveryOn: () => true }));
vi.mock("@vercel/blob", () => ({
  put: async (path: string, _body: unknown, opts: { contentType?: string }) => {
    h.put.push({ path, contentType: opts?.contentType });
    return { url: `https://store-c2.private.blob.vercel-storage.com/${path}` };
  },
}));
vi.mock("sharp", () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    c.rotate = () => c;
    c.resize = () => c;
    c.webp = () => c;
    c.toBuffer = async () => Buffer.from("RIFF0000WEBPVP8 ");
    c.metadata = async () => ({ width: 4, height: 4 });
    return c;
  };
  return { default: (input: unknown) => { if (Buffer.isBuffer(input) && input.length > 16) h.sharpCalls++; return chain(); } };
});
vi.mock("@/lib/import-storage", () => ({
  importStorageAvailable: () => true,
  putImportFile: async (path: string) => { h.put.push({ path }); return { url: `https://store-c2.private.blob.vercel-storage.com/${path}` }; },
  sha256: () => "c2".repeat(32),
}));

import { normaliseUploadFilename, formFields, UPLOAD_LIMITS } from "@/lib/upload-guard";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
const PDF = new TextEncoder().encode("%PDF-1.7\n%secC2\n1 0 obj<<>>endobj\n");

type Part = [string, string | File];
function form(parts: Part[]): FormData {
  const fd = new FormData();
  for (const [k, v] of parts) fd.append(k, v);
  return fd;
}
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });

/** A request whose body records whether anyone read it. */
function trackedReq(url: string, method: string, headers: Record<string, string>) {
  const state = { read: false };
  // highWaterMark 0: the stream pulls only when someone actually reads it.
  const body = new ReadableStream({ pull(c) { state.read = true; c.enqueue(new Uint8Array(8)); c.close(); } }, { highWaterMark: 0 });
  const req = new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
  return { req, state };
}

function seed(bucket: string, n: number) {
  for (let i = 0; i < n; i++) h.hits.push({ bucket, hitAt: new Date() });
}

async function uploadRoute() {
  return (await import("@/app/api/upload/route")).POST;
}
const upReq = (fd: FormData, q = "") => new Request(`http://localhost/api/upload${q}`, { method: "POST", body: fd });

// Warm the route graphs once, under the hook timeout (16 Oct 2026). The first
// cold transform of /api/upload (sharp, blob, rate limiter) used to land inside
// the first test that called uploadRoute() and measured 31 s under a parallel
// run, past the 30 s test timeout. Later vi.resetModules() re-imports still
// re-evaluate the module (a fresh instance, as the tests intend); only the
// transform is reused.
beforeAll(async () => {
  await import("@/app/api/upload/route");
  await import("@/app/api/onboarding/csv-handoff/route");
});

beforeEach(() => {
  h.hits.length = 0;
  h.dbDown = false;
  h.principal = { tenantId: "tenant-c2", userId: "user-c2" };
  h.session = null;
  h.sharpCalls = 0;
  h.put.length = 0;
  h.attachments.length = 0;
  h.importJobs.length = 0;
  h.emails = 0;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_secC2store_fakeTokenNeverUsed";
});

describe("/api/upload — input limits before the body is read", () => {
  it("detector positive control: reading a tracked body is observed", async () => {
    const { req, state } = trackedReq("http://localhost/x", "POST", { "content-type": "text/plain" });
    expect(state.read).toBe(false);
    await req.text();
    expect(state.read).toBe(true);
  });

  it("positive control: a real PNG from the owner is processed and stored under a server-built name", async () => {
    const POST = await uploadRoute();
    const res = await POST(upReq(form([["file", file(PNG, "..\\..\\evil<script>.svg", "image/png")]])));
    expect(res.status).toBe(200);
    expect(h.sharpCalls).toBe(1);
    expect(h.put).toHaveLength(1);
    expect(h.put[0].path).toMatch(/^tenants\/tenant-c2\/[0-9a-f]{24}\.webp$/);
    expect(h.put[0].contentType).toBe("image/webp");
  });

  it("a declared Content-Length over the cap is a 413 — the body is never read, nobody is authenticated, nothing decoded", async () => {
    const POST = await uploadRoute();
    const { req, state } = trackedReq("http://localhost/api/upload", "POST", {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": String(4 * 1024 * 1024 + 64 * 1024 + 1),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(state.read).toBe(false);
    expect(h.hits).toHaveLength(0); // the limiter was not even consulted
    expect(h.sharpCalls).toBe(0);
  });

  it("MIME sniffing: bytes that do not match the declared type are refused before decoding", async () => {
    const POST = await uploadRoute();
    for (const [bytes, type] of [[JPEG, "image/png"], [PNG, "image/jpeg"], [SVG, "image/png"], [PDF, "image/webp"]] as const) {
      const res = await POST(upReq(form([["file", file(bytes, "x.png", type)]])));
      expect(res.status, type).toBe(400);
    }
    expect(h.sharpCalls).toBe(0);
    expect(h.put).toHaveLength(0);
  });

  it("SVG is refused outright (declared image/svg+xml), as are other non-raster types", async () => {
    const POST = await uploadRoute();
    for (const type of ["image/svg+xml", "text/html", "application/pdf", "image/gif", ""]) {
      const res = await POST(upReq(form([["file", file(SVG, "a.svg", type)]])));
      expect(res.status, type).toBe(400);
    }
    expect(h.sharpCalls + h.put.length).toBe(0);
  });

  it("strict fields: unknown or duplicated multipart fields and unknown query parameters are a 400", async () => {
    const POST = await uploadRoute();
    const cases: Array<[Part[], string]> = [
      [[["file", file(PNG, "a.png", "image/png")], ["role", "owner"]], ""],
      [[["file", file(PNG, "a.png", "image/png")], ["tenantId", "other"]], ""],
      [[["file", file(PNG, "a.png", "image/png")], ["file", file(PNG, "b.png", "image/png")]], ""],
      [[["file", file(PNG, "a.png", "image/png")]], "?purpose=branding&tenantId=other"],
      [[["file", file(PNG, "a.png", "image/png")]], "?purpose=BRANDING!"],
      [[["file", file(PNG, "a.png", "image/png")]], "?purpose=a&purpose=b"],
    ];
    for (const [parts, q] of cases) {
      expect((await POST(upReq(form(parts), q))).status, JSON.stringify([parts.map((p) => p[0]), q])).toBe(400);
    }
    expect(h.sharpCalls + h.put.length).toBe(0);
    // The announcement composer's legacy `prefix` field is still accepted (positive control).
    expect((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")], ["prefix", "announcement"]])))).status).toBe(200);
  });

  it("member-scoped: a duplicated targetMemberId is refused instead of picking one", async () => {
    const POST = await uploadRoute();
    h.session = { user: { id: "user-m", tenantId: "tenant-c2", role: "member", memberId: "m-c2-self" } };
    const res = await POST(upReq(form([["file", file(PNG, "a.png", "image/png")], ["targetMemberId", "m-c2-self"], ["targetMemberId", "m-c2-other"]]), "?purpose=profile-pic"));
    expect(res.status).toBe(400);
    const ok = await POST(upReq(form([["file", file(PNG, "a.png", "image/png")], ["targetMemberId", "m-c2-self"]]), "?purpose=profile-pic"));
    expect(ok.status).toBe(200);
  });
});

describe("/api/upload — per-user and per-tenant rate limits (shared DB path)", () => {
  it(`user budget: ${UPLOAD_LIMITS.image.perUser.max} allowed, the next is a 429 with Retry-After, body unread, nothing decoded or stored`, async () => {
    const POST = await uploadRoute();
    for (let i = 0; i < UPLOAD_LIMITS.image.perUser.max; i++) {
      expect((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")]])))).status).toBe(200);
    }
    const before = { sharp: h.sharpCalls, put: h.put.length };
    const { req, state } = trackedReq("http://localhost/api/upload", "POST", { "content-type": "multipart/form-data; boundary=x" });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(state.read).toBe(false);
    expect({ sharp: h.sharpCalls, put: h.put.length }).toEqual(before);
    // Positive control: another user in the same club still has budget.
    h.principal = { tenantId: "tenant-c2", userId: "user-c2-b" };
    expect((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")]])))).status).toBe(200);
  });

  it("tenant budget: a club's accounts together are capped; another club is unaffected", async () => {
    const POST = await uploadRoute();
    seed("upload:image:tenant:tenant-c2", UPLOAD_LIMITS.image.perTenant.max);
    h.principal = { tenantId: "tenant-c2", userId: "user-fresh" };
    expect((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")]])))).status).toBe(429);
    h.principal = { tenantId: "tenant-c2-other", userId: "user-other-club" };
    expect((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")]])))).status).toBe(200);
  });

  it("the limit is shared across instances while the database answers (a fresh module = a new Vercel instance)", async () => {
    seed("upload:image:user:user-c2", UPLOAD_LIMITS.image.perUser.max);
    vi.resetModules();
    const POST = await uploadRoute();
    expect((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")]])))).status).toBe(429);
  });

  it("with the database down, no instance decodes anything: the upload budget is a security bucket, refused (lane C4, R6-N3)", async () => {
    // Before lane C4 each instance fell back to its own memory budget (N instances × limit) — and a burst that
    // saturated the pool reached that fallback on demand. A store failure on a security bucket is now a refusal.
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.dbDown = true;
    const statuses: number[] = [];
    for (let instance = 0; instance < 2; instance++) {
      vi.resetModules();
      const POST = await uploadRoute();
      for (let i = 0; i <= UPLOAD_LIMITS.image.perUser.max; i++) {
        statuses.push((await POST(upReq(form([["file", file(PNG, "a.png", "image/png")]])))).status);
      }
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(0);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2 * (UPLOAD_LIMITS.image.perUser.max + 1));
  });
});

describe("/api/initiatives/[id]/attachments", () => {
  const params = { params: Promise.resolve({ id: "init-c2" }) };
  const attReq = (fd: FormData) => new Request("http://localhost/api/initiatives/init-c2/attachments", { method: "POST", body: fd });

  it("filename is normalised (path, bidi override, control characters) and the blob key is server-built", async () => {
    const { POST } = await import("@/app/api/initiatives/[id]/attachments/route");
    const res = await POST(attReq(form([["file", file(PDF, "..\\..\\invoice\u202Efdp.exe\u0000.pdf", "application/pdf")]])), params);
    expect(res.status).toBe(201);
    expect(h.attachments[0].filename).toBe("invoicefdp.exe.pdf");
    expect(h.put[0].path).toMatch(/^tenants\/tenant-c2\/initiatives\/init-c2\/[0-9a-f]{24}\.pdf$/);
  });

  it("SVG (declared or disguised) is refused; unknown fields are refused", async () => {
    const { POST } = await import("@/app/api/initiatives/[id]/attachments/route");
    expect((await POST(attReq(form([["file", file(SVG, "a.svg", "image/svg+xml")]])), params)).status).toBe(400);
    expect((await POST(attReq(form([["file", file(SVG, "a.png", "image/png")]])), params)).status).toBe(400);
    expect((await POST(attReq(form([["file", file(PDF, "a.pdf", "application/pdf")], ["initiativeId", "other"]])), params)).status).toBe(400);
    expect(h.put).toHaveLength(0);
  });

  it("over the user budget: 429 before the body is read, nothing stored", async () => {
    const { POST } = await import("@/app/api/initiatives/[id]/attachments/route");
    seed("upload:attachment:user:user-c2", UPLOAD_LIMITS.attachment.perUser.max);
    const { req, state } = trackedReq("http://localhost/api/initiatives/init-c2/attachments", "POST", { "content-type": "multipart/form-data; boundary=x" });
    const res = await POST(req, params);
    expect(res.status).toBe(429);
    expect(state.read).toBe(false);
    expect(h.put).toHaveLength(0);
  });

  it("DELETE: attachmentId is validated (missing, duplicated, malformed, or with extra parameters → 400)", async () => {
    const { DELETE } = await import("@/app/api/initiatives/[id]/attachments/route");
    const del = (q: string) => DELETE(new Request(`http://localhost/api/initiatives/init-c2/attachments${q}`, { method: "DELETE" }), params);
    for (const q of ["", "?attachmentId=", "?attachmentId=a&attachmentId=b", "?attachmentId=a%20b", "?attachmentId=a&initiativeId=x"]) {
      expect((await del(q)).status, q).toBe(400);
    }
    expect((await del("?attachmentId=att-1")).status).toBe(200); // positive control
  });
});

describe("/api/onboarding/csv-handoff (each accepted hand-off emails the MatFlow team)", () => {
  const csvReq = (parts: Part[]) => new Request("http://localhost/api/onboarding/csv-handoff", { method: "POST", body: form(parts) });
  const CSV = new TextEncoder().encode("name,email\nA,a@example.com\n");

  it(`${UPLOAD_LIMITS.csvHandoff.perUser.max} hand-offs, then 429 — nothing stored, no further email`, async () => {
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    for (let i = 0; i < UPLOAD_LIMITS.csvHandoff.perUser.max; i++) {
      expect((await POST(csvReq([["file", file(CSV, "members.csv", "text/csv")]]))).status).toBe(201);
    }
    const sent = { put: h.put.length, emails: h.emails, jobs: h.importJobs.length };
    const res = await POST(csvReq([["file", file(CSV, "members.csv", "text/csv")]]));
    expect(res.status).toBe(429);
    expect({ put: h.put.length, emails: h.emails, jobs: h.importJobs.length }).toEqual(sent);
  });

  it("a caller's own mistakes do not spend the budget; unknown fields refused; filename normalised", async () => {
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    expect((await POST(csvReq([["file", file(CSV, "x.docx", "application/msword")]]))).status).toBe(400);
    expect((await POST(csvReq([["file", file(CSV, "m.csv", "text/csv")], ["tenantId", "other"]]))).status).toBe(400);
    expect(h.hits).toHaveLength(0);
    expect((await POST(csvReq([["file", file(CSV, "\u202Evsc.members\u0007.csv", "text/csv")], ["notes", "hi"]]))).status).toBe(201);
    expect(h.importJobs[0].fileName).toBe("vsc.members.csv");
  });
});

describe("/api/admin/import/upload", () => {
  it("over the user budget: 429 before the body is read; under it the request proceeds (positive control)", async () => {
    const { POST } = await import("@/app/api/admin/import/upload/route");
    seed("upload:importUpload:user:user-c2", UPLOAD_LIMITS.importUpload.perUser.max);
    const { req, state } = trackedReq("http://localhost/api/admin/import/upload", "POST", { "content-type": "multipart/form-data; boundary=x" });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(state.read).toBe(false);
    h.principal = { tenantId: "tenant-c2", userId: "user-c2-fresh" };
    const fd = form([["file", file(new TextEncoder().encode("name,email\n"), "m.csv", "text/csv")], ["source", "generic"], ["role", "owner"]]);
    const refused = await POST(new Request("http://localhost/api/admin/import/upload", { method: "POST", body: fd }));
    expect(refused.status).toBe(400); // unknown field `role` refused by the strict form schema
  });
});

describe("lib/upload-guard helpers", () => {
  it.each([
    ["photo.png", "photo.png"],
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\x\\Desktop\\report.pdf", "report.pdf"],
    ["inv\u202Efdp.exe", "invfdp.exe"],
    ["a\u0000b\u001fc\u007fd\u0085e.csv", "abcde.csv"],
    ["zero\u200Bwidth\uFEFF.csv", "zerowidth.csv"],
    ["   ..hidden.csv.  ", "hidden.csv"],
    ["e\u0301.csv", "\u00e9.csv"],
    ["", "upload"],
    ["/", "upload"],
    ["x".repeat(500), "x".repeat(200)],
  ])("normaliseUploadFilename(%j) → %j", (input, out) => {
    expect(normaliseUploadFilename(input)).toBe(out);
  });

  it("normaliseUploadFilename on a non-string returns the fallback", () => {
    expect(normaliseUploadFilename(undefined, "f.csv")).toBe("f.csv");
  });

  it("formFields refuses a field sent twice and never yields prototype keys", () => {
    const dup = new FormData();
    dup.append("a", "1");
    dup.append("a", "2");
    expect(formFields(dup)).toEqual({ ok: false, duplicate: "a" });
    const proto = new FormData();
    proto.append("__proto__", "x");
    proto.append("constructor", "y");
    const r = formFields(proto);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
