// Round 4 (10 Nov 2026), CONCURRENCY-1: club settings saves against the Neon
// TEST branch, through the real PATCH /api/settings handler, as both database
// roles (db-tests.mjs). Synthetic clubs (prefix r4s-), torn down here.
//
// The scenario Noe carried in: admin A saves a field and the save commits but
// A's response is lost; admin B changes the same field; A retries. A's retry
// must not silently overwrite B. The client now sends `expected`: the value it
// last saw for each field it changes. The server applies a field only while it
// still holds that value; a retry that finds its own value already saved
// succeeds without a second change; anything else is a 409 naming the current
// value, and nothing in that save is written.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => {
  class NR extends Response {
    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json" } });
    }
  }
  return { NextRequest: class extends Request {}, NextResponse: NR };
});
const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (entry: Record<string, unknown>) => { audit.calls.push(entry); }),
}));
vi.mock("@/lib/support-refusal-audit", () => ({ recordSupportRefusal: vi.fn(async () => {}), refusedFieldsOf: vi.fn(async () => []) }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH as settingsPatch } from "@/app/api/settings/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4s${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

type Res = { status: number; body: Record<string, unknown> };
const read = async (r: Response): Promise<Res> => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> });

describe.skipIf(!HAS_DB)("CONCURRENCY-1: settings saves do not overwrite a newer value", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  const sessionOf = (k: "A" | "B", role = "owner") => ({ user: { id: owner[k], tenantId: club[k], role, email: `${STAMP}-${k}@example.test` } });
  const patch = async (k: "A" | "B", body: unknown, role = "owner") => {
    authState.session = sessionOf(k, role);
    return read(await settingsPatch(new Request("https://test.local/api/settings", { method: "PATCH", body: JSON.stringify(body) })));
  };
  const row = (k: "A" | "B") => withRlsBypass((tx) => tx.tenant.findUniqueOrThrow({ where: { id: club[k] } }));
  const reset = (k: "A" | "B") => withRlsBypass((tx) => tx.tenant.update({
    where: { id: club[k] },
    data: { name: `${STAMP} ${k}`, primaryColor: "#111111", secondaryColor: "#222222", waiverTitle: null, waiverContent: null },
  }));

  beforeAll(async () => {
    for (const k of ["A", "B"] as const) {
      const t = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}`, primaryColor: "#111111", secondaryColor: "#222222" } }));
      club[k] = t.id;
      const u = await withRlsBypass((tx) => tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, name: `${STAMP} owner ${k}`, role: "owner", passwordHash: "x" } }));
      owner[k] = u.id;
    }
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B].filter(Boolean) } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B].filter(Boolean) } } });
    });
  });

  it("reproduction, the body clients sent before Round 4 (no `expected`): A's retried save overwrites B's newer value", async () => {
    await reset("A");
    expect((await patch("A", { primaryColor: "#aa0000" })).status).toBe(200); // commits; A's reply is lost
    expect((await patch("A", { primaryColor: "#00bb00" })).status).toBe(200); // B
    expect((await patch("A", { primaryColor: "#aa0000" })).status).toBe(200); // A retries
    // Kept as the documented legacy behaviour: a body without `expected`
    // (onboarding, single toggles) is last write wins.
    expect((await row("A")).primaryColor).toBe("#aa0000");
  });

  it("CONCURRENCY-1: A commits (reply lost), B changes the same field, A retries: refused with the current value, B's value kept", async () => {
    await reset("A");
    const aSave = { primaryColor: "#aa0000", expected: { primaryColor: "#111111" } };
    expect((await patch("A", aSave)).status).toBe(200);
    expect((await patch("A", { primaryColor: "#00bb00", expected: { primaryColor: "#aa0000" } })).status).toBe(200);
    audit.calls.length = 0;
    const retry = await patch("A", aSave);
    expect(retry.status).toBe(409);
    expect(retry.body.reason).toBe("stale_settings");
    expect(retry.body.conflicts).toEqual([{ field: "primaryColor", current: "#00bb00" }]);
    expect((await row("A")).primaryColor).toBe("#00bb00");
    expect(audit.calls).toHaveLength(0); // nothing committed, nothing recorded
  });

  it("a retry when nobody else changed it succeeds, and records the change once", async () => {
    await reset("A");
    const aSave = { primaryColor: "#aa0000", expected: { primaryColor: "#111111" } };
    audit.calls.length = 0;
    expect((await patch("A", aSave)).status).toBe(200);
    const retry = await patch("A", aSave);
    expect(retry.status).toBe(200);
    expect((await row("A")).primaryColor).toBe("#aa0000");
    expect(audit.calls.filter((c) => c.action === "tenant.settings.update")).toHaveLength(1);
  });

  it("a conflict on one field refuses the whole save: the other field in it is not written either", async () => {
    await reset("A");
    await patch("A", { primaryColor: "#00bb00", expected: { primaryColor: "#111111" } }); // B
    const r = await patch("A", { primaryColor: "#aa0000", secondaryColor: "#aa1111", expected: { primaryColor: "#111111", secondaryColor: "#222222" } });
    expect(r.status).toBe(409);
    const after = await row("A");
    expect([after.primaryColor, after.secondaryColor]).toEqual(["#00bb00", "#222222"]);
  });

  it("two admins at once, different fields: both kept", async () => {
    await reset("A");
    const [x, y] = await Promise.all([
      patch("A", { primaryColor: "#aa0000", expected: { primaryColor: "#111111" } }),
      patch("A", { name: `${STAMP} renamed`, expected: { name: `${STAMP} A` } }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const after = await row("A");
    expect([after.primaryColor, after.name]).toEqual(["#aa0000", `${STAMP} renamed`]);
  });

  it("two admins at once, same field from the same starting value: exactly one wins, the other is told", async () => {
    await reset("A");
    const results = await Promise.all([
      patch("A", { primaryColor: "#aa0000", expected: { primaryColor: "#111111" } }),
      patch("A", { primaryColor: "#00bb00", expected: { primaryColor: "#111111" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? "#aa0000" : "#00bb00";
    expect((await row("A")).primaryColor).toBe(winner);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.conflicts).toEqual([{ field: "primaryColor", current: winner }]);
  });

  it("long text (waiver): a stale save of the old text cannot replace newer text", async () => {
    await reset("A");
    await patch("A", { waiverTitle: "v2", waiverContent: "Second version", expected: { waiverTitle: null, waiverContent: null } });
    const stale = await patch("A", { waiverTitle: "v1", waiverContent: "First version", expected: { waiverTitle: null, waiverContent: null } });
    expect(stale.status).toBe(409);
    expect((await row("A")).waiverContent).toBe("Second version");
  });

  it("tenant and role isolation: another club's save never touches this club; a manager is refused", async () => {
    await reset("A");
    await reset("B");
    expect((await patch("B", { primaryColor: "#bbbbbb", expected: { primaryColor: "#111111" } })).status).toBe(200);
    expect((await row("A")).primaryColor).toBe("#111111");
    expect((await patch("A", { primaryColor: "#cccccc", expected: { primaryColor: "#111111" } }, "manager")).status).toBe(403);
    expect((await row("A")).primaryColor).toBe("#111111");
  });

  it("`expected` for a field not being saved is refused (it would be a precondition on nothing)", async () => {
    await reset("A");
    const r = await patch("A", { primaryColor: "#aa0000", expected: { name: "anything" } });
    expect(r.status).toBe(400);
    expect((await row("A")).primaryColor).toBe("#111111");
  });
});
