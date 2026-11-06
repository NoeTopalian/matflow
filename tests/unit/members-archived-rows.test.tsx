// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), usePathname: () => "/" }));

import { inStatusView } from "@/components/dashboard/MembersList";

/**
 * PR 3 review: an archived member is listed only where a count includes them,
 * so each chip's count and list agree: the two debt chips (a debt is never
 * hidden) and the movement drill-throughs. Every other view leaves them out.
 */
const archivedAt = "2026-11-01T10:00:00.000Z";
const rows = [
  { id: "cur", status: "active", accountType: "adult" },
  { id: "debt", status: "active", accountType: "adult", archivedAt, otherOwing: true },
  { id: "rec", status: "inactive", accountType: "adult", archivedAt, failedToReconcile: true },
  { id: "mover", status: "active", accountType: "adult", archivedAt, moved: ["new" as const] },
];
const listed = (f: string) => rows.filter((m) => inStatusView(m as never, f as never)).map((m) => m.id);

describe("archived rows on the Members page", () => {
  it("each debt chip lists exactly the accounts its count counts, archived ones included", () => {
    // The server's counts (otherOwingTotals) include the archived debtor and the archived account to reconcile.
    expect(listed("other-owing")).toEqual(["debt"]);
    expect(listed("failed-to-reconcile")).toEqual(["rec"]);
  });
  it("an archived mover is in the movement drill-through it was counted in", () => {
    expect(listed("new-this-month")).toEqual(["mover"]);
  });
  it("no other view lists an archived row", () => {
    for (const f of ["all", "active", "inactive", "attention", "overdue", "quiet", "cancelled", "kids", "guardians"]) {
      expect(listed(f).filter((id) => id !== "cur"), f).toEqual([]);
    }
  });
});
