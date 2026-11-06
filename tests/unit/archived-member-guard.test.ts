import { describe, it, expect, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) } }));
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => fn({ member: { findFirst } }) }));

import { refuseArchivedMember, ARCHIVED_MEMBER_READ_ONLY } from "@/lib/archived-member-guard";

describe("refuseArchivedMember (PR 3: an archived record is read-only on the server)", () => {
  it("answers 409 for an archived member, tenant-scoped", async () => {
    findFirst.mockResolvedValueOnce({ archivedAt: new Date() });
    const res = (await refuseArchivedMember("t1", "m1")) as unknown as { status: number; json: () => Promise<{ error: string }> };
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(ARCHIVED_MEMBER_READ_ONLY);
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "m1", tenantId: "t1" });
  });
  it("lets a current member through, and leaves not-found to the route", async () => {
    findFirst.mockResolvedValueOnce({ archivedAt: null });
    expect(await refuseArchivedMember("t1", "m1")).toBeNull();
    findFirst.mockResolvedValueOnce(null);
    expect(await refuseArchivedMember("t1", "m2")).toBeNull();
  });
  it("every member write route the review named calls it", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "app/api/members/[id]/route.ts", "app/api/members/[id]/rank/route.ts", "app/api/members/[id]/rank/demote/route.ts",
      "app/api/members/[id]/hold/route.ts", "app/api/members/[id]/resume/route.ts", "app/api/members/[id]/photos/route.ts",
      "app/api/members/[id]/profile-picture/route.ts", "app/api/members/[id]/promote-to-adult/route.ts",
      "app/api/members/[id]/unlink-child/route.ts", "app/api/members/[id]/guardian/route.ts",
      "app/api/members/[id]/waiver/sign/route.ts", "app/api/members/[id]/card/revoke/route.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).toContain("refuseArchivedMember(");
    }
    // Recording a payment against an archived member's debt stays allowed.
    expect(readFileSync("app/api/payments/manual/route.ts", "utf8")).not.toContain("refuseArchivedMember(");
  });
});
