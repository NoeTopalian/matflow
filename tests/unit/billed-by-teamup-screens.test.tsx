// @vitest-environment jsdom
//
// Honest screens for a member TeamUp bills (readiness spec v3 §7; contract
// docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md §2, §4, §5):
//   - the staff profile says "Billed by TeamUp · status as of <date>" by the
//     payment status, and warns once the standing is more than 8 days old
//     (frozen clock: 7 d 23 h → no warning, 8 d 1 h → warning);
//   - the members list marks the row with a "TeamUp" pill carrying the full label;
//   - the register shows the stale warning and never blocks the tick for it;
//   - the hold dialog says the pause is MatFlow-only;
//   - the manual chase asks first, with TeamUp's own-reminders sentence.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn(), useSession: () => ({ data: null, status: "authenticated" }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import MemberProfile, { type MemberDetail } from "@/components/dashboard/MemberProfile";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import OutstandingPanel from "@/components/dashboard/OutstandingPanel";
import { BilledByTeamUpPill } from "@/components/dashboard/BilledByTeamUpPill";
import { CHASE_ELSEWHERE_NOTE, HOLD_ACCESS_ONLY_NOTE, staleBillingWarning } from "@/lib/billing-source";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: Array<{ url: string; init?: RequestInit }> = [];
function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const AS_OF = "2026-09-20T09:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(new Date(AS_OF).getTime() + hours * HOUR);

beforeEach(() => {
  toastSpy.mockClear();
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Staff member profile ────────────────────────────────────────────────────

const MEMBER: MemberDetail = {
  id: "mem_1",
  name: "Sam Carter",
  email: "sam@example.com",
  phone: "07000000000",
  membershipType: "Adults Advanced 2026",
  membershipTierId: null,
  status: "active",
  paymentStatus: "paid",
  billedBy: "teamup",
  billingStatusAsOf: AS_OF,
  notes: null,
  profilePictureUrl: null,
  joinedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-30T09:00:00.000Z",
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  medicalConditions: null,
  dateOfBirth: null,
  waiverAccepted: true,
  waiverAcceptedAt: null,
  subscriptions: [],
  ranks: [],
  attendances: [],
};

async function renderProfile(member: MemberDetail = MEMBER) {
  installFetch((url) => (url.includes("/payments") ? json({ payments: [] }) : json({})));
  render(<MemberProfile member={member} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
  await act(async () => {});
}

describe("staff profile", () => {
  it("shows 'Billed by TeamUp · status as of <date>' for a TeamUp-billed member", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(24));
    await renderProfile();
    expect(screen.getByTestId("billing-source-label").textContent).toBe("Billed by TeamUp · status as of 20 Sept 2026");
  });

  it("shows no label for a member MatFlow bills", async () => {
    await renderProfile({ ...MEMBER, billedBy: "matflow", billingStatusAsOf: null });
    expect(screen.queryByTestId("billing-source-label")).toBeNull();
    expect(screen.queryByTestId("stale-billing-warning")).toBeNull();
  });

  it("frozen clock at 7 days 23 hours: no stale warning", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(7 * 24 + 23));
    await renderProfile();
    expect(screen.queryByTestId("stale-billing-warning")).toBeNull();
  });

  it("frozen clock at 8 days 1 hour: the stale warning is shown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(8 * 24 + 1));
    await renderProfile();
    expect(screen.getByTestId("stale-billing-warning").textContent).toBe(
      "Billing status last updated 20 Sept — check TeamUp before relying on it.",
    );
  });

  it("the hold dialog says the pause is MatFlow-only, above the confirm button", async () => {
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Put on hold…" }));
    const note = await screen.findByTestId("hold-teamup-note");
    expect(note.textContent).toBe(HOLD_ACCESS_ONLY_NOTE);
    const confirm = screen.getByRole("button", { name: "Put on hold" });
    // The note comes before the confirm button in document order.
    expect(note.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the hold dialog carries no TeamUp note for a member MatFlow bills", async () => {
    await renderProfile({ ...MEMBER, billedBy: "matflow", billingStatusAsOf: null });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Put on hold…" }));
    await screen.findByRole("button", { name: "Put on hold" });
    expect(screen.queryByTestId("hold-teamup-note")).toBeNull();
  });
});

// ─── Members list pill ───────────────────────────────────────────────────────

describe("members list marker", () => {
  it("is a 'Billed by TeamUp' pill whose title carries the full label, and nothing for MatFlow billing", () => {
    const { rerender } = render(<BilledByTeamUpPill member={{ billedBy: "teamup", billingStatusAsOf: AS_OF }} />);
    const pill = screen.getByTestId("billed-by-teamup");
    // Functional review F5 (30 Sep 2026): "TeamUp" alone said nothing.
    expect(pill.textContent).toBe("Billed by TeamUp");
    expect(pill.getAttribute("title")).toBe("Billed by TeamUp · status as of 20 Sept 2026");
    rerender(<BilledByTeamUpPill member={{ billedBy: "matflow", billingStatusAsOf: null }} />);
    expect(screen.queryByTestId("billed-by-teamup")).toBeNull();
  });
});

// ─── Register ────────────────────────────────────────────────────────────────

const INSTANCE = {
  id: "inst-1", classId: "c1", name: "Beginner BJJ", coachName: "Coach", location: "Mat 1", color: "#3b82f6",
  startTime: "10:00", endTime: "11:00", maxCapacity: 20, attendedCount: 0, waitlistCount: 0,
  status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: false,
};

describe("register", () => {
  it("shows the stale warning on the row, and the tick still checks the member in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(10 * 24));
    installFetch((url, init) => {
      if (url.includes("/register")) {
        return json({
          expected: [{ memberId: "m1", name: "Tess Stale", accountType: "adult", waiverAccepted: true, rank: null, attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null, billedBy: "teamup", billingStatusAsOf: AS_OF }],
          waitlist: [],
        });
      }
      if (url === "/api/checkin" && init?.method === "POST") return json({ ok: true }, 201);
      if (url.includes("/api/checkin/members")) return json([]);
      return json({});
    });
    render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
    const warn = await screen.findByTestId("register-stale-billing");
    expect(warn.textContent).toMatch(/Billing status last updated 20 Sept/);
    fireEvent.click(screen.getByRole("button", { name: "Mark Tess Stale attended" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/checkin" && c.init?.method === "POST")).toBe(true));
  });

  // Functional review F3 (30 Sep 2026): with a fresh standing the register
  // said nothing about who collects the member's money.
  it("shows who collects the money when the standing is fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(24));
    installFetch((url) => {
      if (url.includes("/register")) {
        return json({
          expected: [{ memberId: "m1", name: "Fay Fresh", accountType: "adult", waiverAccepted: true, rank: null, attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null, billedBy: "teamup", billingStatusAsOf: AS_OF }],
          waitlist: [],
        });
      }
      if (url.includes("/api/checkin/members")) return json([]);
      return json({});
    });
    render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
    const label = await screen.findByTestId("register-billing-source");
    expect(label.textContent).toBe("Billed by TeamUp · status as of 20 Sept 2026");
    expect(screen.queryByTestId("register-stale-billing")).toBeNull();
  });

  it("says PLAN UNDECIDED · STAFF DECIDE for a TeamUp-billed member with no plan set (acceptance P2, 2 Oct 2026), never for one with a plan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(24));
    installFetch((url) => {
      if (url.includes("/register")) {
        return json({
          expected: [
            { memberId: "m1", name: "Dee Decide", accountType: "adult", waiverAccepted: true, rank: null, attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null, billedBy: "teamup", billingStatusAsOf: AS_OF, membershipType: null },
            { memberId: "m2", name: "Pat Planned", accountType: "adult", waiverAccepted: true, rank: null, attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null, billedBy: "teamup", billingStatusAsOf: AS_OF, membershipType: "Adults Advanced 2026" },
          ],
          waitlist: [],
        });
      }
      if (url.includes("/api/checkin/members")) return json([]);
      return json({});
    });
    render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
    await screen.findByText("Dee Decide");
    expect(screen.getAllByText("PLAN UNDECIDED · STAFF DECIDE")).toHaveLength(1);
  });
});

// ─── Manual chase ────────────────────────────────────────────────────────────

describe("manual chase", () => {
  const rows = [
    { memberId: "m_tu", memberName: "Terry TeamUp", membershipType: "Adults", amountPence: 5000, amountSource: "plan_price", reason: null, daysOverdue: 3, lastAttempt: null, billedBy: "teamup" },
    { memberId: "m_mf", memberName: "Mo MatFlow", membershipType: "Adults", amountPence: 5000, amountSource: "plan_price", reason: null, daysOverdue: 2, lastAttempt: null, billedBy: "matflow" },
  ];
  function install() {
    installFetch((url) => {
      if (url === "/api/payments/outstanding") return json({ rows, total: 2, totalPence: 10000 });
      if (url === "/api/payments/chase") return json({ ok: true });
      return json({});
    });
  }
  const chases = () => calls.filter((c) => c.url === "/api/payments/chase");

  it("for a TeamUp-billed member, asks first with the TeamUp sentence, then sends", async () => {
    install();
    render(<OutstandingPanel />);
    await screen.findByText("Terry TeamUp");
    const [teamupChase] = screen.getAllByRole("button", { name: /Chase/ });
    fireEvent.click(teamupChase);
    expect(await screen.findByText(CHASE_ELSEWHERE_NOTE)).toBeTruthy();
    expect(chases()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send reminder" }));
    await waitFor(() => expect(chases()).toHaveLength(1));
    expect(JSON.parse(String(chases()[0].init?.body))).toEqual({ memberId: "m_tu" });
  });

  it("for a MatFlow-billed member, sends straight away with no TeamUp sentence", async () => {
    install();
    render(<OutstandingPanel />);
    await screen.findByText("Mo MatFlow");
    const buttons = screen.getAllByRole("button", { name: /Chase/ });
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(chases()).toHaveLength(1));
    expect(screen.queryByText(CHASE_ELSEWHERE_NOTE)).toBeNull();
  });
});

describe("staleness boundary (pure)", () => {
  it("is exactly 8 days", () => {
    const m = { billedBy: "teamup", billingStatusAsOf: AS_OF };
    expect(staleBillingWarning(m, at(8 * 24 - 1))).toBeNull();
    expect(staleBillingWarning(m, at(8 * 24 + 1))).not.toBeNull();
    expect(staleBillingWarning({ billedBy: "matflow", billingStatusAsOf: AS_OF }, at(30 * 24))).toBeNull();
  });
});
