// CSV hand-off retry safety on a real database (onboarding batch 1, 16 Oct 2026).
//
// The wizard sends one random clientRef per chosen file and resends it on
// every retry. A retry after a lost response must find the first job instead
// of storing the file again, creating a second job and emailing the team
// twice — including when the retry overlaps the first attempt.
//
// The overlap is forced, not hoped for: the blob store mock holds every put()
// until both requests have reached it, so both have passed the route's first
// lookup before either creates a job. Only the advisory lock and the second
// lookup inside the transaction stand between them and two jobs.
//
// Synthetic club (unique slug, example.test address), removed in afterAll.
// Run with the TEST-branch runners (owner role AND restricted matflow_app
// role); skips without a DB, refuses anything but the TEST branch.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { classifyDbTarget, skipReason, assertTestBranch } from "./helpers/db-target";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...mod, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 })) };
});
const h = vi.hoisted(() => ({
  gate: { tenantId: "", userId: "" },
  emails: 0,
  puts: [] as string[],
  dels: [] as string[],
  barrier: null as null | { need: number; arrived: number; open: () => void; opened: Promise<void> },
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: h.gate.tenantId, userId: h.gate.userId, session: { user: { id: h.gate.userId, tenantId: h.gate.tenantId, role: "owner" } } })),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => { h.emails++; return { ok: true, logId: "test" }; }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (pathname: string) => {
    const url = `https://blob.test/${pathname.replace(/\.csv$/, "")}-${Math.random().toString(36).slice(2, 8)}.csv`;
    h.puts.push(url);
    const b = h.barrier;
    if (b) { b.arrived++; if (b.arrived >= b.need) b.open(); await b.opened; }
    return { url };
  }),
  del: vi.fn(async (url: string) => { h.dels.push(url); }),
}));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/onboarding/csv-handoff/route";

const KIND = classifyDbTarget(process.env.DATABASE_URL);
const STAMP = `csvref${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ref = () => Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

function req(clientRef: string, name = "members.csv") {
  const fd = new FormData();
  fd.append("file", new File(["name,email\nA,a@example.test\n"], name, { type: "text/csv" }));
  fd.append("clientRef", clientRef);
  return new Request("http://localhost/api/onboarding/csv-handoff", { method: "POST", body: fd });
}
const jobs = () => withRlsBypass((tx) => tx.importJob.findMany({ where: { tenantId: h.gate.tenantId }, select: { id: true, fileBlobUrl: true } }));
function reset() { h.emails = 0; h.puts.length = 0; h.dels.length = 0; h.barrier = null; }
function holdPuts(need: number) {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  h.barrier = { need, arrived: 0, open, opened };
}

describe.skipIf(KIND === "none" || KIND === "skip")(`csv hand-off clientRef on the database ${skipReason(KIND)}`, () => {
  beforeAll(async () => {
    assertTestBranch(process.env.DATABASE_URL);
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_never_used";
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} Club`, slug: `${STAMP}-club`, onboardingCompleted: false, subscriptionStatus: "trial" } });
      const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "!unusable-test-hash" } });
      h.gate.tenantId = t.id;
      h.gate.userId = u.id;
    });
  }, 60_000);

  afterAll(async () => {
    if (!h.gate.tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.importJob.deleteMany({ where: { tenantId: h.gate.tenantId } });
      await tx.user.deleteMany({ where: { tenantId: h.gate.tenantId } });
      await tx.tenant.deleteMany({ where: { id: h.gate.tenantId } });
    });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { id: h.gate.tenantId } }));
    expect(left).toBe(0);
    await prisma.$disconnect();
  }, 60_000);

  it("two overlapping requests with one reference create one job and one email", async () => {
    reset();
    const r = ref();
    holdPuts(2);
    const [a, b] = await Promise.all([POST(req(r)), POST(req(r))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    const replay = (a.status === 200 ? await a.json() : await b.json()) as { alreadyReceived?: boolean; jobId: string };
    const first = (a.status === 201 ? await a.json() : await b.json()) as { jobId: string };
    expect(replay.alreadyReceived).toBe(true);
    expect(replay.jobId).toBe(first.jobId);
    const rows = (await jobs()).filter((j) => j.fileBlobUrl.includes(`/handoff-${r}`));
    expect(rows).toHaveLength(1);
    expect(h.emails).toBe(1);
    // The loser's copy of the file is dropped; the winner's is the job's.
    expect(h.puts).toHaveLength(2);
    expect(h.dels).toHaveLength(1);
    expect(h.dels[0]).not.toBe(rows[0].fileBlobUrl);
  }, 60_000);

  it("a retry after the first was accepted stores nothing and returns the same job", async () => {
    reset();
    const r = ref();
    const first = await POST(req(r));
    expect(first.status).toBe(201);
    const { jobId } = (await first.json()) as { jobId: string };
    const retry = await POST(req(r));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ jobId, alreadyReceived: true });
    expect(h.puts).toHaveLength(1);
    expect(h.emails).toBe(1);
    expect((await jobs()).filter((j) => j.fileBlobUrl.includes(`/handoff-${r}`))).toHaveLength(1);
  }, 60_000);

  it("the same reference with different content is refused and creates nothing (content hash on the job)", async () => {
    reset();
    const r = ref();
    expect((await POST(req(r))).status).toBe(201);
    const other = new FormData();
    other.append("file", new File(["name,email\nB,b@example.test\n"], "members.csv", { type: "text/csv" }));
    other.append("clientRef", r);
    const res = await POST(new Request("http://localhost/api/onboarding/csv-handoff", { method: "POST", body: other }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "handoff_ref_mismatch" });
    expect((await jobs()).filter((j) => j.fileBlobUrl.includes(`/handoff-${r}`))).toHaveLength(1);
    expect(h.emails).toBe(1);
  }, 60_000);

  it("a different file (new reference) is a new hand-off", async () => {
    reset();
    const before = (await jobs()).length;
    expect((await POST(req(ref(), "a.csv"))).status).toBe(201);
    expect((await POST(req(ref(), "b.csv"))).status).toBe(201);
    expect((await jobs()).length).toBe(before + 2);
    expect(h.emails).toBe(2);
  }, 60_000);
});
