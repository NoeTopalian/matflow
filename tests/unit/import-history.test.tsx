// @vitest-environment jsdom
//
// Import history (verifier, 30 Sep 2026, D1/D3/D7).
//
// The Import panel kept the job it had just run in page state only: a reload
// lost it, a past import could not be rolled back, and the route's own "see
// import history for details" pointed at nothing. These tests pin the list
// (GET /api/admin/import) and the screen that reads it:
//   - the route is owner-only, tenant-filtered, and never returns fileBlobUrl;
//   - an HTTP error is an error state, never "No imports yet" (UI-RULES §7);
//   - Roll back calls the member route for member jobs and the attendance
//     route for attendance jobs, and shows what was kept and why;
//   - the plural helper says "1 member", not "1 members".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { gateMock, findManyMock, findFirstMock } = vi.hoisted(() => ({ gateMock: vi.fn(), findManyMock: vi.fn(), findFirstMock: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => gateMock() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn({ importJob: { findMany: findManyMock, findFirst: findFirstMock } }),
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }),
}));
vi.mock("@/lib/import-storage", () => ({ importStorageAvailable: () => true, putImportFile: vi.fn(), sha256: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/importers", () => ({ MAPPING_VERSION: {} }));

// The confirm dialog is answered "yes" straight away; its own behaviour is
// covered by its own tests.
vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({ ask: async () => true, dialogProps: {} }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { GET } from "@/app/api/admin/import/route";
import ImportHistory, { plural, HISTORY_ERROR } from "@/components/dashboard/ImportHistory";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function dbJob(over: Record<string, unknown> = {}) {
  return {
    id: "job_m",
    tenantId: "t-A",
    createdById: "u1",
    source: "teamup",
    fileName: "members.csv",
    fileBlobUrl: "https://blob.example/secret-members.csv",
    status: "complete",
    totalRows: 10,
    processedRows: 10,
    importedRows: 8,
    skippedRows: 1,
    errorRows: 1,
    errorLog: [{ row: 4, reason: "Invalid email" }],
    dryRunSummary: null,
    fileHash: "abcdef0123456789",
    sourceExportedAt: new Date("2026-09-28T09:00:00Z"),
    mappingVersion: "teamup@1",
    manifest: { reconciles: true, created: { total: 8, unmatchedPlan: 0 } },
    rolledBackAt: null,
    startedAt: null,
    completedAt: new Date("2026-09-29T10:00:00Z"),
    createdAt: new Date("2026-09-29T09:59:00Z"),
    ...over,
  };
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: "job_m",
    kind: "members",
    source: "teamup",
    fileName: "members.csv",
    status: "complete",
    createdAt: "2026-09-29T09:59:00.000Z",
    completedAt: "2026-09-29T10:00:00.000Z",
    rolledBackAt: null,
    importedRows: 8,
    skippedRows: 1,
    errorRows: 0,
    sourceExportedAt: "2026-09-28T09:00:00.000Z",
    mappingVersion: "teamup@1",
    reconciles: true,
    createdTotal: 8,
    rollback: null,
    rowErrors: [],
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t-A", userId: "u1" });
  findFirstMock.mockResolvedValue(null);
});

// ── The route ────────────────────────────────────────────────────────────────

describe("GET /api/admin/import", () => {
  it("is owner-only: a failed gate answers with the gate's response and reads nothing", async () => {
    gateMock.mockResolvedValue({ ok: false, response: { status: 403, json: async () => ({ error: "Forbidden" }) } });
    const res = (await GET()) as unknown as { status: number };
    expect(res.status).toBe(403);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("filters on the caller's tenant, newest first, last 50", async () => {
    findManyMock.mockResolvedValue([]);
    await GET();
    const args = findManyMock.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: "t-A" });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.take).toBe(50);
  });

  it("never returns fileBlobUrl, and projects kind, reconciliation and rollback", async () => {
    findManyMock.mockResolvedValue([
      dbJob({
        rolledBackAt: new Date("2026-09-30T08:00:00Z"),
        manifest: {
          reconciles: true,
          created: { total: 8, unmatchedPlan: 0 },
          createdMemberIds: ["m1", "m2"],
          rollback: { removed: 6, kept: [{ memberId: "m9", name: "Sam Kept", reasons: ["has signed in"] }] },
        },
      }),
      dbJob({
        id: "job_a",
        source: "teamup-attendance",
        fileName: "attendance.csv",
        manifest: { kind: "attendance", reconciles: false, created: { total: 120 }, createdInstanceIds: ["ci1"] },
      }),
    ]);
    const res = (await GET()) as unknown as { json: () => Promise<{ jobs: Record<string, unknown>[] }> };
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("fileBlobUrl");
    expect(text).not.toContain("secret-members.csv");
    // Only the figures the screen needs leave the manifest.
    expect(text).not.toContain("createdMemberIds");
    expect(text).not.toContain("createdInstanceIds");

    const [m, a] = body.jobs;
    expect(m.kind).toBe("members");
    expect(m.reconciles).toBe(true);
    expect(m.createdTotal).toBe(8);
    expect(m.rollback).toEqual({ kind: "members", removed: 6, kept: [{ memberId: "m9", name: "Sam Kept", reasons: ["has signed in"] }] });
    expect(m.rowErrors).toEqual([{ row: 4, reason: "Invalid email" }]);
    expect(a.kind).toBe("attendance");
    expect(a.reconciles).toBe(false);
    expect(a.createdTotal).toBe(120);
  });
});

// ── The screen ───────────────────────────────────────────────────────────────

describe("ImportHistory", () => {
  it("renders one row per job, with its kind, status and counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      jobs: [
        item(),
        item({ id: "job_a", kind: "attendance", source: "teamup-attendance", fileName: "attendance.csv", importedRows: 1, skippedRows: 0 }),
      ],
    })));
    render(<ImportHistory />);
    await waitFor(() => expect(screen.getAllByTestId("import-history-row")).toHaveLength(2));
    expect(screen.getByText("members.csv")).toBeTruthy();
    expect(screen.getByText("attendance.csv")).toBeTruthy();
    expect(screen.getByText(/Attendance history ·/)).toBeTruthy();
    expect(screen.getByText("8 members imported · 1 skipped")).toBeTruthy();
    expect(screen.getByText("1 record imported")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Roll back/ })).toHaveLength(2);
  });

  it("says 'No imports yet' only for a genuinely empty history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [] })));
    render(<ImportHistory />);
    await waitFor(() => expect(screen.getByText("No imports yet")).toBeTruthy());
  });

  it("shows an error, never 'No imports yet', when the list answers 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "boom" }, 500)));
    render(<ImportHistory />);
    await waitFor(() => expect(screen.getByText(HISTORY_ERROR)).toBeTruthy());
    expect(screen.queryByText("No imports yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows an error when the request never arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    render(<ImportHistory />);
    await waitFor(() => expect(screen.getByText(HISTORY_ERROR)).toBeTruthy());
    expect(screen.queryByText("No imports yet")).toBeNull();
  });

  it("rolls a member import back through the member route and lists who was kept and why", async () => {
    let rolled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/import/job_m/rollback") {
        rolled = true;
        return jsonResponse({ ok: true, removed: 6, kept: [{ memberId: "m9", name: "Sam Kept", reasons: ["has signed in", "has paid"] }] });
      }
      if (url === "/api/admin/import" && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          jobs: [rolled
            ? item({ rolledBackAt: "2026-09-30T08:00:00.000Z", rollback: { kind: "members", removed: 6, kept: [{ memberId: "m9", name: "Sam Kept", reasons: ["has signed in", "has paid"] }] } })
            : item()],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<ImportHistory onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Roll back/ }));

    await waitFor(() => expect(screen.getByTestId("history-rollback-outcome")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/import/job_m/rollback", { method: "POST" });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/attendance"))).toBe(false);
    expect(screen.getByText(/Rolled back — 6 members removed/)).toBeTruthy();
    expect(screen.getByText(/1 kept because someone had already used them/)).toBeTruthy();
    expect(screen.getByText(/has signed in, has paid/)).toBeTruthy();
    expect(screen.getByText("Rolled back")).toBeTruthy();
    // Some members were kept, so the rest can be rolled back later (verifier lane 5, round 2).
    expect(screen.getByRole("button", { name: "Roll back the rest" })).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith("job_m");
  });

  it("rolls an attendance import back through the attendance route", async () => {
    let rolled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/import/attendance?jobId=job_a" && init?.method === "DELETE") {
        rolled = true;
        return jsonResponse({ ok: true, recordsRemoved: 1, instancesRemoved: 2, instancesKept: 0 });
      }
      if (url === "/api/admin/import") {
        return jsonResponse({
          jobs: [item({
            id: "job_a", kind: "attendance", source: "teamup-attendance", fileName: "attendance.csv",
            ...(rolled ? { rolledBackAt: "2026-09-30T08:00:00.000Z", rollback: { kind: "attendance", recordsRemoved: 1, instancesRemoved: 2, instancesKept: 0 } } : {}),
          })],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ImportHistory />);
    fireEvent.click(await screen.findByRole("button", { name: /Roll back/ }));

    await waitFor(() => expect(screen.getByTestId("history-rollback-outcome")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/import/attendance?jobId=job_a", { method: "DELETE" });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/rollback"))).toBe(false);
    expect(screen.getByText(/Rolled back — 1 attendance record removed/)).toBeTruthy();
    expect(screen.getByText(/2 past class sessions it created removed/)).toBeTruthy();
  });

  it("shows the route's own sentence when a rollback is refused", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/rollback")) return jsonResponse({ error: "This import was already rolled back" }, 409);
      return jsonResponse({ jobs: [item()] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ImportHistory />);
    fireEvent.click(await screen.findByRole("button", { name: /Roll back/ }));
    await waitFor(() => expect(screen.getByText("This import was already rolled back")).toBeTruthy());
  });
});

// ── Status refresh (readiness spec v3 §7) ───────────────────────────────────

describe("status refresh in the history", () => {
  it("the route labels a refresh job, counts its exceptions, and states the last successful refresh", async () => {
    findManyMock.mockResolvedValue([
      dbJob({
        id: "job_r",
        mode: "refresh",
        manifest: {
          mode: "refresh",
          reconciles: true,
          refresh: {
            changed: 3,
            unchanged: 40,
            changes: [{ memberId: "m1", name: "Secret Person", before: {}, after: {} }],
            exceptions: { notInMatFlow: [{ name: "New" }], notInFile: [{ memberId: "m7", name: "Gone" }], billedByMatFlow: [], refused: [] },
          },
        },
      }),
    ]);
    findFirstMock.mockResolvedValue({ id: "job_r", completedAt: new Date("2026-09-29T10:00:00Z"), sourceExportedAt: new Date("2026-09-28T09:00:00Z") });
    const res = (await GET()) as unknown as { json: () => Promise<{ jobs: Record<string, unknown>[]; lastSuccessfulRefresh: unknown }> };
    const body = await res.json();
    expect(body.jobs[0].mode).toBe("refresh");
    expect(body.jobs[0].refresh).toEqual({ changed: 3, unchanged: 40, exceptions: 2 });
    // Per-person before/after stays on the server.
    expect(JSON.stringify(body)).not.toContain("Secret Person");
    expect(body.lastSuccessfulRefresh).toEqual({ jobId: "job_r", completedAt: "2026-09-29T10:00:00.000Z", sourceExportedAt: "2026-09-28T09:00:00.000Z" });
    expect(findFirstMock.mock.calls[0][0].where).toEqual({ tenantId: "t-A", mode: "refresh", status: "complete", rolledBackAt: null });
  });

  it("the screen says 'Status refresh', the export time, and the last successful refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      jobs: [item({ id: "job_r", mode: "refresh", refresh: { changed: 3, unchanged: 40, exceptions: 2 } }), item({ mode: "create" })],
      lastSuccessfulRefresh: { jobId: "job_r", completedAt: "2026-09-29T10:00:00.000Z", sourceExportedAt: "2026-09-28T09:00:00.000Z" },
    })));
    render(<ImportHistory />);
    await waitFor(() => expect(screen.getAllByTestId("import-history-row")).toHaveLength(2));
    expect(screen.getByText(/Status refresh ·/)).toBeTruthy();
    expect(screen.getByText("3 members changed · 40 unchanged · 2 exceptions")).toBeTruthy();
    expect(screen.getAllByText(/TeamUp export of/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("last-successful-refresh").textContent).toMatch(/Last successful status refresh: TeamUp export of .*28 Sept?/);
  });

  it("a refresh rollback shows who was restored and who was kept, and offers the rest", async () => {
    let rolled = false;
    const kept = [{ memberId: "m2", name: "Kim Kept", reasons: ["payment status changed since this refresh"] }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/admin/import/job_r/rollback") { rolled = true; return jsonResponse({ ok: true, mode: "refresh", restored: 2, kept }); }
      return jsonResponse({
        jobs: [item({
          id: "job_r", mode: "refresh", refresh: { changed: 3, unchanged: 0, exceptions: 0 },
          ...(rolled ? { rolledBackAt: "2026-09-30T08:00:00.000Z", rollback: { kind: "refresh", restored: 2, kept } } : {}),
        })],
        lastSuccessfulRefresh: null,
      });
    }));
    render(<ImportHistory />);
    fireEvent.click(await screen.findByRole("button", { name: /Roll back/ }));
    await waitFor(() => expect(screen.getByTestId("history-rollback-outcome")).toBeTruthy());
    expect(screen.getByText(/2 members restored to their previous standing/)).toBeTruthy();
    expect(screen.getByText(/payment status changed since this refresh/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Roll back the rest" })).toBeTruthy();
  });
});

describe("plural", () => {
  it("says 1 member and 2 members", () => {
    expect(plural(1, "member", "members")).toBe("1 member");
    expect(plural(2, "member", "members")).toBe("2 members");
    expect(plural(0, "member", "members")).toBe("0 members");
    expect(plural(1, "child", "children")).toBe("1 child");
    expect(plural(1200, "record", "records")).toBe("1,200 records");
  });
});
