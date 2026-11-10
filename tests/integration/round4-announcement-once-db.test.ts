// Round 4 (10 Nov 2026): a notice posted twice by a double click or a retry
// after a lost reply appears once. Real POST /api/announcements and the real
// rate-limit store, Neon TEST branch, both database roles (db-tests.mjs).
// Synthetic clubs (r4a-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as postAnnouncement } from "@/app/api/announcements/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4a${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!HAS_DB)("announcements: posted once per click burst", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  const as = (k: "A" | "B") => mockAuth.mockResolvedValue({ user: { id: owner[k], tenantId: club[k], role: "owner", email: `${STAMP}-${k}@example.test` } } as never);
  const post = async (title: string, body = "Mats closed Saturday for the grading.") => {
    const r = (await postAnnouncement(new Request("https://test.local/api/announcements", {
      method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify({ title, body }),
    }))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const count = (k: "A" | "B", title: string) => withRlsBypass((tx) => tx.announcement.count({ where: { tenantId: club[k], title } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}` } });
        club[k] = t.id;
        owner[k] = (await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } })).id;
      }
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.rateLimitHit.deleteMany({ where: { OR: [{ bucket: { contains: club.A } }, { bucket: { contains: club.B } }] } });
      await tx.announcement.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("two identical posts at once (a double click): one notice; the repeat gets it, or is told it is being posted", async () => {
    as("A");
    audit.calls.length = 0;
    const results = await Promise.all([post("Grading day"), post("Grading day")]);
    const created = results.filter((r) => r.status === 201);
    const repeat = results.find((r) => r.status !== 201)!;
    expect(created).toHaveLength(1);
    // The repeat arrives before or after the first commits: either it gets the
    // same notice (200), or it is told the notice is being posted (409).
    if (repeat.status === 200) expect(repeat.body.id).toBe(created[0].body.id);
    else expect(repeat).toMatchObject({ status: 409, body: { reason: "announcement_in_flight" } });
    expect(await count("A", "Grading day")).toBe(1);
    expect(audit.calls.filter((c) => c.action === "announcement.created")).toHaveLength(1);
  });

  it("a retry after a lost reply gets the same notice, not a second one", async () => {
    as("A");
    const first = await post("Open mat moved");
    const retry = await post("Open mat moved");
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retry.body.id).toBe(first.body.id);
    expect(await count("A", "Open mat moved")).toBe(1);
  });

  it("different text is a different notice; another club's identical notice is its own", async () => {
    as("A");
    expect((await post("Grading day", "A different message.")).status).toBe(201);
    as("B");
    expect((await post("Grading day")).status).toBe(201);
    expect(await count("B", "Grading day")).toBe(1);
    expect(await count("A", "Grading day")).toBe(2);
  });
});
