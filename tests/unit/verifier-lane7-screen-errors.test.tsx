// @vitest-environment jsdom
//
// Independent verifier lane 7 (30 Sep 2026) — screen-side error handling.
//
//   D1  the staff profile save sends the row version it was opened on, and a
//       409 conflict is said in a sentence with the input kept
//   D4  a dropped request and an HTML 500 each produce a sentence, input kept
//   D13 a failed payments load shows no "(0)" count and no "0 records"
//   D7  a failed register load offers Try again, and it reloads the register
//   D5  a failed member-home load never renders "No classes coming up" or
//       "0 classes" underneath the error
//   D8/D11 member self-service details: a 401 says the session expired; a
//       too-long name is not called missing
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/components/member/SignaturePad", () => ({
  __esModule: true,
  default: React.forwardRef(function MockPad() {
    return <div data-testid="signature-pad" />;
  }),
}));
vi.mock("@/components/member/ClassPacksWidget", () => ({ __esModule: true, default: () => null }));
vi.mock("@/components/member/FamilySection", () => ({ __esModule: true, default: () => null }));
vi.mock("@/components/member/EmergencyMedicalSection", () => ({ __esModule: true, default: () => null }));
vi.mock("@/components/member/SignWaiverSection", () => ({ __esModule: true, default: () => null }));

import MemberProfile, { type MemberDetail } from "@/components/dashboard/MemberProfile";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import MemberHomePage from "@/app/member/home/page";
import MemberProfilePage from "@/app/member/profile/page";

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: Array<{ url: string; init?: RequestInit }> = [];
function installFetch(handler: Handler) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  toastSpy.mockClear();
  // This repo's jsdom config wraps localStorage in a non-functional store.
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
  vi.restoreAllMocks();
});

// ─── Staff member profile ────────────────────────────────────────────────────

const OPENED_AT = "2026-09-30T09:00:00.000Z";
const MEMBER: MemberDetail = {
  id: "mem_1",
  name: "Sam Carter",
  email: "sam@example.com",
  phone: null,
  membershipType: null,
  membershipTierId: null,
  status: "active",
  paymentStatus: "paid",
  notes: null,
  profilePictureUrl: null,
  joinedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: OPENED_AT,
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

function profileFetch(patch: Handler, payments: Handler = () => json({ payments: [] })) {
  installFetch((url, init) => {
    if (url === `/api/members/${MEMBER.id}` && init?.method === "PATCH") return patch(url, init);
    if (url.startsWith(`/api/members/${MEMBER.id}/payments`)) return payments(url, init);
    return json({});
  });
}

async function openEditAndChangeName(newName: string) {
  render(
    <MemberProfile
      member={MEMBER}
      rankOptions={[]}
      primaryColor="#3b82f6"
      role="owner"
      tenantSlug="t"
    />,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  const input = screen.getByDisplayValue("Sam Carter") as HTMLInputElement;
  fireEvent.change(input, { target: { value: newName } });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  return () => screen.getByDisplayValue(newName) as HTMLInputElement;
}

const patches = () => calls.filter((c) => c.init?.method === "PATCH");

describe("staff profile save (D1, D4)", () => {
  it("D1: sends the updatedAt the page was opened on", async () => {
    profileFetch(() => json({ ...MEMBER, name: "Sam Carter-Jones", updatedAt: "2026-09-30T09:05:00.000Z" }));
    await openEditAndChangeName("Sam Carter-Jones");
    await waitFor(() => expect(patches()).toHaveLength(1));
    const body = JSON.parse(String(patches()[0].init!.body));
    expect(body.updatedAt).toBe(OPENED_AT);
  });

  it("D1: the next save carries the version the previous save produced", async () => {
    const next = "2026-09-30T09:05:00.000Z";
    profileFetch(() => json({ ...MEMBER, updatedAt: next }));
    await openEditAndChangeName("Sam Carter-Jones");
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Profile updated", "success"));
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(JSON.parse(String(patches()[1].init!.body)).updatedAt).toBe(next);
  });

  it("D1: a 409 conflict says someone else changed the member, and keeps the input", async () => {
    profileFetch(() =>
      json({ error: "This member was updated by someone else. Reload and try again.", currentUpdatedAt: "2026-09-30T09:03:00.000Z" }, 409),
    );
    const field = await openEditAndChangeName("Sam Carter-Jones");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Someone else changed this member since you opened it/);
    expect(field().value).toBe("Sam Carter-Jones");
  });

  it("D4: a dropped request says so and keeps the input", async () => {
    profileFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const field = await openEditAndChangeName("Sam Carter-Jones");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't reach MatFlow/);
    expect(field().value).toBe("Sam Carter-Jones");
  });

  it("D4: an HTML 500 page says so and keeps the input", async () => {
    profileFetch(() => new Response("<html><body>Internal Server Error</body></html>", { status: 500, headers: { "Content-Type": "text/html" } }));
    const field = await openEditAndChangeName("Sam Carter-Jones");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/nothing was saved/);
    expect(field().value).toBe("Sam Carter-Jones");
  });

  it("D8: a 401 says the session expired, not 'Unauthorized'", async () => {
    profileFetch(() => json({ error: "Unauthorized" }, 401));
    await openEditAndChangeName("Sam Carter-Jones");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/session has expired/);
    expect(alert.textContent).not.toMatch(/Unauthorized/);
  });
});

describe("payments tab under an error (D13)", () => {
  it("shows no count and no '0 records' when payments failed to load", async () => {
    profileFetch(() => json({}), () => json({ error: "Temporarily unavailable" }, 503));
    render(<MemberProfile member={MEMBER} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
    await act(async () => {});
    const tab = screen.getByRole("tab", { name: /payments/i });
    expect(tab.textContent).toBe("Payments");
    fireEvent.click(tab);
    await screen.findByText(/Couldn't load this member's payments/);
    expect(screen.queryByText(/0 records/)).toBeNull();
  });

  it("still shows the count once payments have loaded", async () => {
    profileFetch(() => json({}));
    render(<MemberProfile member={MEMBER} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /payments/i }).textContent).toBe("Payments (0)"));
  });
});

// ─── Register (D7) ───────────────────────────────────────────────────────────

const INSTANCE = {
  id: "inst-1",
  classId: "c1",
  name: "Beginner BJJ",
  coachName: "Coach Mike",
  location: "Mat 1",
  color: "#3b82f6",
  startTime: "10:00",
  endTime: "11:00",
  maxCapacity: 20,
  attendedCount: 0,
  waitlistCount: 0,
  status: "ongoing" as const,
  isCancelled: false,
  cancellationReason: null,
  isMine: false,
};

describe("register roster failure (D7)", () => {
  it("offers Try again, which reloads the register", async () => {
    let registerCalls = 0;
    installFetch((url) => {
      if (url.includes("/register")) {
        registerCalls += 1;
        return registerCalls === 1
          ? json({ error: "Service unavailable" }, 503)
          : json({ expected: [{ memberId: "m1", name: "Noe Topalian", accountType: "adult", waiverAccepted: true, rank: null, attended: false, attendedMethod: null, lastVisitAt: null, medicalConditions: null }], waitlist: [] });
      }
      if (url.includes("/api/checkin/members")) return json([]);
      return json({});
    });
    render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
    const retry = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(retry);
    await screen.findByText("Noe Topalian");
    expect(registerCalls).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ─── Member home (D5) ────────────────────────────────────────────────────────

describe("member home under a load error (D5)", () => {
  it("never renders the empty next-class or '0 classes' under the error", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/member/home")) return json({ error: "Temporarily unavailable" }, 503);
      return json({});
    });
    render(<MemberHomePage />);
    await screen.findByText(/Couldn't load your details/);
    expect(screen.queryByText(/No classes coming up/)).toBeNull();
    expect(screen.queryByText(/0 classes/)).toBeNull();
    expect(screen.queryByText(/Today's Classes/)).toBeNull();
  });

  it("renders the sections once the load succeeds", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/member/home")) {
        return json({
          me: { name: "Sam Carter", onboardingCompleted: true, accountType: "adult", nextClass: null },
          schedule: [],
          children: [],
          announcements: { announcements: [] },
        });
      }
      return json({});
    });
    render(<MemberHomePage />);
    await screen.findByText(/No classes coming up/);
    expect(screen.getByText(/Today's Classes/)).toBeTruthy();
  });
});

// ─── Member self-service details (D8, D11) ───────────────────────────────────

function memberProfileFetch(patch: Handler) {
  installFetch((url, init) => {
    if (url === "/api/member/me" && init?.method === "PATCH") return patch(url, init);
    if (url === "/api/member/me") {
      return json({ id: "mem_1", name: "Sam Carter", email: "sam@example.com", phone: null, hasPassword: true, totpEnabled: false });
    }
    return json({});
  });
}

async function openDetails() {
  render(<MemberProfilePage />);
  const edit = await screen.findByRole("button", { name: /edit personal details/i });
  fireEvent.click(edit);
  return screen.getByLabelText("Name") as HTMLInputElement;
}

describe("member self-service details (D8, D11)", () => {
  it("D11: a name over the limit is told the limit, not 'Enter your name'", async () => {
    memberProfileFetch(() => json({}));
    const name = await openDetails();
    fireEvent.change(name, { target: { value: "a".repeat(300) } });
    fireEvent.submit(name.closest("form")!);
    await screen.findByText("Your name must be 120 characters or fewer.");
    expect(screen.queryByText("Enter your name")).toBeNull();
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
  });

  it("D8: a 401 says the session expired, not 'Unauthorized'", async () => {
    memberProfileFetch(() => json({ error: "Unauthorized" }, 401));
    const name = await openDetails();
    fireEvent.change(name, { target: { value: "Sam C" } });
    fireEvent.submit(name.closest("form")!);
    await screen.findByText(/session has expired/);
    expect(screen.queryByText("Unauthorized")).toBeNull();
    expect(name.value).toBe("Sam C");
  });
});

// Round 4 (10 Nov 2026): the notes box expects the notes it loaded. A save
// refused because another admin changed them keeps the draft and offers the
// latest or a knowing overwrite; nothing resubmits on its own.
describe("staff profile notes (Round 4)", () => {
  async function openNotes(initialNotes: string | null) {
    render(<MemberProfile member={{ ...MEMBER, notes: initialNotes }} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("tab", { name: /Internal Notes/ }));
    const box = screen.getByLabelText("Internal notes about this member") as HTMLTextAreaElement;
    return box;
  }

  it("sends the notes it loaded as expectedNotes", async () => {
    profileFetch(() => json({ updatedAt: "2026-09-30T09:05:00.000Z" }));
    const box = await openNotes("Old note");
    fireEvent.change(box, { target: { value: "New note" } });
    fireEvent.click(screen.getByRole("button", { name: /Save notes/ }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0].init!.body))).toEqual({ notes: "New note", expectedNotes: "Old note" });
  });

  it("a conflict keeps the draft; 'Save mine instead' resends expecting the newer notes; 'Use the latest' shows them", async () => {
    let answer = () => json({ error: "changed", reason: "stale_notes", currentNotes: "Their note", currentUpdatedAt: "2026-09-30T09:06:00.000Z" }, 409);
    profileFetch(() => answer());
    const box = await openNotes("Old note");
    fireEvent.change(box, { target: { value: "My note" } });
    fireEvent.click(screen.getByRole("button", { name: /Save notes/ }));
    const notice = await screen.findByTestId("settings-conflict");
    expect(notice.textContent).toContain("These notes were changed by someone else");
    expect(box.value).toBe("My note");
    answer = () => json({ updatedAt: "2026-09-30T09:07:00.000Z" });
    fireEvent.click(screen.getByRole("button", { name: "Save mine instead" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(JSON.parse(String(patches()[1].init!.body))).toEqual({ notes: "My note", expectedNotes: "Their note" });
  });

  it("'Use the latest' replaces the box with the other admin's notes and sends nothing", async () => {
    profileFetch(() => json({ error: "changed", reason: "stale_notes", currentNotes: "Their note", currentUpdatedAt: "2026-09-30T09:06:00.000Z" }, 409));
    const box = await openNotes("Old note");
    fireEvent.change(box, { target: { value: "My note" } });
    fireEvent.click(screen.getByRole("button", { name: /Save notes/ }));
    await screen.findByTestId("settings-conflict");
    fireEvent.click(screen.getByRole("button", { name: "Use the latest" }));
    expect(box.value).toBe("Their note");
    expect(patches()).toHaveLength(1);
  });

  it("no reply keeps the draft and says it is unknown", async () => {
    profileFetch(() => { throw new TypeError("Failed to fetch"); });
    const box = await openNotes("Old note");
    fireEvent.change(box, { target: { value: "Unsure note" } });
    fireEvent.click(screen.getByRole("button", { name: /Save notes/ }));
    await waitFor(() => expect(toastSpy.mock.calls.some((c) => /isn't known whether the notes were saved/.test(String(c[0])))).toBe(true));
    expect(box.value).toBe("Unsure note");
  });

  // Review H: a notes conflict never hands the page another admin's row
  // version, so the next profile save is still checked against the version
  // its fields were loaded with (and is refused if someone changed them).
  it("after 'Use the latest', a profile save still sends the version the page opened with", async () => {
    let answer = () => json({ error: "changed", reason: "stale_notes", currentNotes: "Their note", currentUpdatedAt: "2026-09-30T09:06:00.000Z" }, 409); // a version the page must not adopt
    profileFetch(() => answer());
    const box = await openNotes("Old note");
    fireEvent.change(box, { target: { value: "My note" } });
    fireEvent.click(screen.getByRole("button", { name: /Save notes/ }));
    await screen.findByTestId("settings-conflict");
    fireEvent.click(screen.getByRole("button", { name: "Use the latest" }));
    answer = () => json({ ...MEMBER, updatedAt: "2026-09-30T09:09:00.000Z" });
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByDisplayValue("Sam Carter"), { target: { value: "Sam C" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(JSON.parse(String(patches()[1].init!.body)).updatedAt).toBe(OPENED_AT);
  });
});

