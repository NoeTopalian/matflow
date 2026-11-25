// Custom class colours (25 Nov 2026): what PATCH /api/classes/[id] stores. Real route, Neon TEST branch, both
// database roles (db-tests.mjs). Synthetic clubs (ccc-), torn down here.
//  - A hex code is stored exactly as sent; null clears it (the class shows the club's colour).
//  - The stored colour in other letter case is not written, and the Activity row does not say it changed.
//  - Anything that is not a hex code is refused (400) and nothing changes.
//  - A class saved earlier with a non-hex value keeps it through an unrelated edit.
//  - Only the edited class changes; another club cannot change it.

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
import { PATCH } from "@/app/api/classes/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `ccc${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!HAS_DB)("class colour: what an edit stores", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  let classId = "";
  let otherId = "";
  const as = (k: "A" | "B") => mockAuth.mockResolvedValue({ user: { id: owner[k], tenantId: club[k], role: "owner", email: `${STAMP}-${k}@example.test` } } as never);
  const patch = async (body: unknown, id = classId) => {
    const r = (await PATCH(new Request(`http://test/api/classes/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const colourOf = async (id = classId) => (await withRlsBypass((tx) => tx.class.findUniqueOrThrow({ where: { id }, select: { color: true } }))).color;
  const setColour = (color: string | null) => withRlsBypass((tx) => tx.class.update({ where: { id: classId }, data: { color } }));
  /** The colour before/after of the last class.updated audit row, if it records one. */
  const lastAuditColour = () => {
    const meta = (audit.calls.at(-1)?.metadata ?? {}) as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    return { before: meta.before?.color, after: meta.after?.color, recorded: !!meta.after && "color" in meta.after };
  };

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}` } });
        club[k] = t.id;
        owner[k] = (await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } })).id;
      }
      // Two classes in the club, one category's worth: only the edited one may change.
      classId = (await tx.class.create({ data: { tenantId: club.A, name: "Fundamentals", duration: 60, color: "#3b82f6" } })).id;
      otherId = (await tx.class.create({ data: { tenantId: club.A, name: "No-Gi", duration: 60, color: "#3b82f6" } })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.class.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { slug: { startsWith: STAMP } } }));
    expect(left).toBe(0);
  });

  it("stores a custom hex code exactly as sent, and records the change", async () => {
    as("A");
    const r = await patch({ color: "#1a2b3c" });
    expect(r.status).toBe(200);
    expect(await colourOf()).toBe("#1a2b3c");
    expect(lastAuditColour()).toMatchObject({ before: "#3b82f6", after: "#1a2b3c", recorded: true });
    expect(await colourOf(otherId)).toBe("#3b82f6");
  });

  it("the same colour in other letter case is not written, and the Activity row does not say the colour changed", async () => {
    await setColour("#1A2B3C");
    as("A");
    const r = await patch({ color: "#1a2b3c", name: "Fundamentals" });
    expect(r.status).toBe(200);
    expect(await colourOf()).toBe("#1A2B3C");
    expect(lastAuditColour().recorded).toBe(false);
  });

  it.each(["url(//x.example/a)", "red", "#12345g", "1a2b3c", "#", "#123456789", "rgb(1,2,3)"])("refuses %j and changes nothing", async (bad) => {
    await setColour("#224466");
    as("A");
    const r = await patch({ color: bad });
    expect(r.status).toBe(400);
    expect(await colourOf()).toBe("#224466");
  });

  it("a class saved earlier with a non-hex value keeps it through an unrelated edit", async () => {
    await setColour("teal");
    as("A");
    const r = await patch({ name: "Fundamentals Gi" });
    expect(r.status).toBe(200);
    expect(await colourOf()).toBe("teal");
    await withRlsBypass((tx) => tx.class.update({ where: { id: classId }, data: { name: "Fundamentals" } }));
  });

  it("null clears it: the class shows the club's colour again", async () => {
    await setColour("#224466");
    as("A");
    expect((await patch({ color: null })).status).toBe(200);
    expect(await colourOf()).toBeNull();
  });

  it("another club cannot change it", async () => {
    await setColour("#224466");
    as("B");
    const r = await patch({ color: "#000000" });
    expect(r.status).toBe(404);
    expect(await colourOf()).toBe("#224466");
  });
});
