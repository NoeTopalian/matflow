// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Lane L-C round 1, defect 5.
 *
 * All four CSV-import routes are `requireApiOwner`
 * (admin/import/upload:61, [id]/preview:16, [id]/commit:23, [id]:10), but the
 * panel that drives them rendered for any member of staff who could open the
 * settings screen. A manager got the source picker, the file input and the
 * Upload button, and every one of them answered 403 — the nav-vs-gate class of
 * defect: a control that is visible, enabled, and cannot ever work.
 *
 * The routes are the intended rule (an import writes the whole roster), so the
 * UI moves to meet them rather than the other way round.
 */

const { useSessionMock } = vi.hoisted(() => ({ useSessionMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));

vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({ ask: vi.fn(), dialogProps: {} }),
}));

import ImportPanel from "@/components/dashboard/ImportPanel";

function sessionAs(role: string | null) {
  useSessionMock.mockReturnValue(
    role === null
      ? { data: null, status: "unauthenticated" }
      : { data: { user: { id: "u1", role, tenantId: "t-A" } }, status: "authenticated" },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("ImportPanel — the CSV import is owner-only, like its routes", () => {
  it("renders the importer for an owner", () => {
    sessionAs("owner");
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    expect(screen.getByText(/member csv import/i)).toBeTruthy();
    expect(container.querySelector('select[aria-label="Source"]'), "the owner gets the source picker").toBeTruthy();
  });

  for (const role of ["manager", "coach", "admin"]) {
    it(`renders nothing at all for a ${role}`, () => {
      sessionAs(role);
      const { container } = render(<ImportPanel primaryColor="#d62828" />);
      expect(
        container.textContent?.trim(),
        `a ${role} must not be shown a control whose every route answers 403`,
      ).toBe("");
    });

    it(`gives a ${role} no file input and no upload control`, () => {
      sessionAs(role);
      const { container } = render(<ImportPanel primaryColor="#d62828" />);
      expect(container.querySelector('input[type="file"]')).toBeNull();
      expect(container.querySelector("button")).toBeNull();
      expect(container.querySelector('select[aria-label="Source"]')).toBeNull();
    });
  }

  it("renders nothing while the session is still loading, rather than flashing the importer", () => {
    useSessionMock.mockReturnValue({ data: null, status: "loading" });
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    expect(container.textContent?.trim()).toBe("");
  });

  it("renders nothing when there is no session at all", () => {
    sessionAs(null);
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    expect(container.textContent?.trim()).toBe("");
  });
});
