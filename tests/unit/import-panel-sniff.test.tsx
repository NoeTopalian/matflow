// @vitest-environment jsdom
/**
 * The Import panel reads the chosen file's header (lib/importers/sniff.ts) so
 * the owner cannot run the wrong parser by accident (3 Oct 2026): a TeamUp
 * memberships export chosen under the default "Generic CSV" switches the
 * Source to TeamUp and says so; a file meant for the other import is named
 * and the submit button is disabled. Valid generic files are left alone.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { useSessionMock } = vi.hoisted(() => ({ useSessionMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));
vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({ ask: vi.fn(), dialogProps: {} }),
}));
vi.mock("@/components/dashboard/ImportHistory", () => ({
  default: () => null,
  plural: (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`,
}));

import ImportPanel from "@/components/dashboard/ImportPanel";

const TEAMUP =
  "﻿Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date\r\nAda,ada@example.test,,Adults Advanced 2026,recurring,active,Stripe,2026-01-14,2026-01-14\r\n";
const ATTENDANCE = "Attendance ID,Customer Email,Customer Name,Event Name,Start Date,Start Time,Status\nA1,ada@example.test,Ada,Fundamentals,2026-09-01,18:00,attended\n";
const GENERIC = "name,email\nAda,ada@example.test\n";

function choose(container: HTMLElement, content: string) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([content], "export.csv", { type: "text/csv" })] } });
}
const sourceSelect = (c: HTMLElement) => c.querySelector('select[aria-label="Source"]') as HTMLSelectElement;
const submit = () => screen.getByRole("button", { name: /upload \+ preview/i }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  useSessionMock.mockReturnValue({ data: { user: { id: "u1", role: "owner", tenantId: "t-A" } }, status: "authenticated" });
});

describe("ImportPanel — the file's header picks the path", () => {
  it("switches Source to TeamUp for a TeamUp memberships export and says so", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    expect(sourceSelect(container).value).toBe("generic");
    choose(container, TEAMUP);
    await waitFor(() => expect(screen.getByTestId("import-source-detected").textContent).toMatch(/Detected a TeamUp memberships export — Source set to TeamUp/));
    expect(sourceSelect(container).value).toBe("teamup");
  });

  it("if the owner switches back to Generic, names the problem and disables submit", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    choose(container, TEAMUP);
    await waitFor(() => expect(sourceSelect(container).value).toBe("teamup"));
    fireEvent.change(sourceSelect(container), { target: { value: "generic" } });
    expect(screen.getByTestId("import-file-mismatch").textContent).toMatch(/Choose Source: TeamUp/);
    expect(submit().disabled).toBe(true);
  });

  it("names an attendance export on the Members tab and disables submit", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    choose(container, ATTENDANCE);
    await waitFor(() => expect(screen.getByTestId("import-file-mismatch").textContent).toMatch(/attendance export.*Attendance history/i));
    expect(submit().disabled).toBe(true);
  });

  it("names a memberships export on the Attendance tab and disables submit", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    fireEvent.click(screen.getByRole("button", { name: "Attendance history" }));
    choose(container, TEAMUP);
    await waitFor(() => expect(screen.getByTestId("import-file-mismatch").textContent).toMatch(/memberships export.*Members with Source: TeamUp/));
    expect(submit().disabled).toBe(true);
  });

  it("leaves a valid generic file on Generic with no note", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    choose(container, GENERIC);
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(sourceSelect(container).value).toBe("generic");
    expect(screen.queryByTestId("import-source-detected")).toBeNull();
    expect(screen.queryByTestId("import-file-mismatch")).toBeNull();
  });
});
