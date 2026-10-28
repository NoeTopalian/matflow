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
    // The Attendance tab (components/dashboard/AttendanceImport.tsx) first asks
    // whether an import is already waiting; none here.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ job: null }) })));
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    fireEvent.click(screen.getByRole("button", { name: "Attendance history" }));
    await waitFor(() => expect(container.querySelector("#attendance-file")).not.toBeNull());
    choose(container, TEAMUP);
    await waitFor(() => expect(screen.getByTestId("import-file-mismatch").textContent).toMatch(/memberships export.*Members with Source: TeamUp/));
    expect((screen.getByTestId("attendance-upload-preview") as HTMLButtonElement).disabled).toBe(true);
    vi.unstubAllGlobals();
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

describe("ImportPanel — the export time and its provenance", () => {
  it("sends the typed club wall-clock time, and 'provisional' when the estimate box is ticked", async () => {
    const sent: FormData[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: unknown }) => {
      if (init?.body instanceof FormData) sent.push(init.body);
      return { ok: false, json: async () => ({ error: "stop here" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { container } = render(<ImportPanel primaryColor="#d62828" />);
      choose(container, TEAMUP);
      await waitFor(() => expect(sourceSelect(container).value).toBe("teamup"));
      fireEvent.change(container.querySelector("#import-exported-at") as HTMLInputElement, { target: { value: "2026-10-02T18:00" } });
      fireEvent.click(screen.getByRole("checkbox", { name: /this is an estimate/i }));
      expect(submit().disabled).toBe(false);
      // jsdom cannot give a file input a value, so its `required` would block a click; submit the form.
      fireEvent.submit(submit().closest("form")!);
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].get("source")).toBe("teamup");
      expect(sent[0].get("sourceExportedAtLocal")).toBe("2026-10-02T18:00");
      expect(sent[0].get("sourceExportedAt")).toBeNull();
      expect(sent[0].get("sourceExportedAtProvenance")).toBe("provisional");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an estimate with no time cannot be submitted", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" />);
    choose(container, TEAMUP);
    await waitFor(() => expect(sourceSelect(container).value).toBe("teamup"));
    fireEvent.click(screen.getByRole("checkbox", { name: /this is an estimate/i }));
    expect(submit().disabled).toBe(true);
  });
});

describe("ImportPanel — people imported without a plan are a warning before commit, not a refusal (27 Oct 2026 rule)", () => {
  it("says who will be imported without a plan, with the file's label and the reason, never 'create the tiers', and leaves Import enabled", async () => {
    const job = { id: "job1", source: "teamup", mode: "create", fileName: "export.csv", status: "pending", totalRows: 0, processedRows: 0, importedRows: 0, skippedRows: 0, errorRows: 0, errorLog: null, dryRunSummary: null };
    const preview = {
      totalRows: 3, validRows: 3, errorRows: 0, existingMatches: 0, willImport: 3, willSkip: 0, sampleDrafts: [], sampleErrors: [],
      willImportWithPlan: 0, willImportWithoutPlan: 3,
      planReview: [
        { label: "Beginner Course", reason: "source_has_no_price_facts", why: "the TeamUp export has no price, billing period or currency, so no plan can be confirmed", people: 2 },
        { label: "Kids Unlimited 2026", reason: "source_has_no_price_facts", why: "the TeamUp export has no price, billing period or currency, so no plan can be confirmed", people: 1 },
      ],
      teamup2: {
        asOf: "2026-10-02", asOfIsProvisional: false, asOfProvenance: "owner_stated",
        ledger: { rows: 3, byDisposition: { member_history: 3 } }, decisions: [], scheduled: [],
        guardians: { suggestedFromSharedEmail: 0, draftsFromEmergencyContact: 0 },
        exceptions: { missingEmailActive: 0, sharedEmailAdults: 0, cancelledWithoutDate: 0, unmatchedPlanLabels: ["Beginner Course", "Kids Unlimited 2026"], unmatchedHistoryPlanLabels: ["Kids & Beginners Course (OLD)"], refusedRows: 0 },
        exceptionRows: [],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).endsWith("/preview") ? preview : job),
    })));
    try {
      const { container } = render(<ImportPanel primaryColor="#d62828" />);
      choose(container, TEAMUP);
      await waitFor(() => expect(sourceSelect(container).value).toBe("teamup"));
      fireEvent.change(container.querySelector("#import-exported-at") as HTMLInputElement, { target: { value: "2026-10-02T18:00" } });
      fireEvent.submit(submit().closest("form")!);
      const box = await screen.findByTestId("import-without-plan");
      expect(box.textContent).toMatch(/3 new people will be imported without a plan/);
      expect(box.textContent).toMatch(/File says Beginner Course \(2 people\): the TeamUp export has no price, billing period or currency/);
      expect(box.textContent).toMatch(/Kids Unlimited 2026/);
      expect(box.textContent).not.toMatch(/Kids & Beginners Course \(OLD\)/);
      expect(box.textContent).toMatch(/Plan-restricted classes may refuse them until staff assign a plan\./);
      expect(box.textContent).not.toMatch(/Create the missing tiers/);
      expect(screen.queryByTestId("import-missing-tiers")).toBeNull();
      expect((screen.getByRole("button", { name: /Import 3 members/ }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
