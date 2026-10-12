// @vitest-environment jsdom
// Guided conflict resolution UI (admin hub lane F, 9 Oct 2026; AH-04 / I3).
// components/admin/ConflictPanel.tsx against a scripted fetch: the order of
// requests, what each carries, the double-click guard, the lost-response
// re-send of the SAME grant (never an automatic retry), the honest partial
// state with a resume point in the URL, and the resumed panel.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup, within } from "@testing-library/react";
import React from "react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import ConflictPanel, { loadResume, type CheckResult, type CheckedHolder } from "@/components/admin/ConflictPanel";
import LoginEmailCard from "@/app/admin/tenants/[id]/LoginEmailCard";

const ADDRESS = "owner.real@club.example";
const HELD: CheckResult = {
  free: false,
  tenant: { id: "t-a", name: "Club A" },
  owner: { id: "u-owner", name: "Owen Owner" },
  holder: {
    kind: "member", id: "m-pat", name: "Pat Imported", status: "active",
    canSignIn: true, access: "activation_pending", link: "/dashboard/members/m-pat", version: "a".repeat(64),
  },
};
const FREE: CheckResult = { free: true, tenant: HELD.tenant, owner: HELD.owner };

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
let script: Record<string, Array<() => Promise<Response> | Response>> = {};
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const key = (url: string) =>
  url.includes("/auth/step-up") ? "stepup"
    : url.includes("/login-email/check") ? "check"
      : url.includes("/contact-email") ? "contact"
        : url.includes("/login-email") ? "owner" : "other";

beforeEach(() => {
  calls = [];
  script = {};
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/admin/tenants/t-a");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body ?? "{}")) });
    const next = script[key(url)]?.shift();
    if (!next) throw new Error(`unscripted request ${url}`);
    return next();
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel(extra: Partial<React.ComponentProps<typeof ConflictPanel>> = {}) {
  const onOwnerChanged = vi.fn();
  const onClose = vi.fn();
  render(<ConflictPanel tenantId="t-a" ownerUserId="u-owner" address={ADDRESS} check={HELD} onOwnerChanged={onOwnerChanged} onClose={onClose} {...extra} />);
  return { onOwnerChanged, onClose };
}

function verify() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText(/how you verified it/i), { target: { value: "call-back to the club number on file, ticket 41" } });
}

async function memberStep(code = "123456") {
  fireEvent.click(screen.getByRole("button", { name: /change this member's contact address/i }));
  fireEvent.change(screen.getByLabelText(/new contact address/i), { target: { value: "pat.personal@club.example" } });
  fireEvent.change(screen.getByLabelText(/^your authenticator code/i), { target: { value: code } });
}

const byKey = (k: string) => calls.filter((c) => key(c.url) === k);

describe("ConflictPanel", () => {
  it("shows club, owner and holder, warns that a name is not proof, and needs the verified tick AND a note", () => {
    renderPanel();
    expect(screen.getByText("Club A")).toBeTruthy();
    expect(screen.getByText("Owen Owner")).toBeTruthy();
    expect(screen.getByText("Pat Imported")).toBeTruthy();
    expect(screen.getByText(/can activate/i)).toBeTruthy();
    expect(screen.getByText(/a matching name is not proof/i)).toBeTruthy();
    const start = screen.getByRole("button", { name: /change this member's contact address/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(start.disabled).toBe(true); // tick alone is not enough
    fireEvent.change(screen.getByLabelText(/how you verified it/i), { target: { value: "call-back to the club number on file" } });
    expect(start.disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox")); // untick: a note alone is not enough either
    expect(start.disabled).toBe(true);
  });

  it("full sequence: grant → member change → automatic re-check → separate grant → owner change → result with ids", async () => {
    script = {
      stepup: [() => ok({ ok: true, grant: "grant-member" }), () => ok({ ok: true, grant: "grant-owner" })],
      contact: [() => ok({ ok: true, memberId: "m-pat", canSignIn: false, retired: { resetCodes: 1, signInLinks: 2 } })],
      check: [() => ok({ ok: true, ...FREE })],
      owner: [() => ok({ ok: true, email: ADDRESS, provisional: true })],
    };
    const { onOwnerChanged } = renderPanel();
    verify();
    await memberStep();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^change contact address$/i })); });
    await screen.findByText(/the address is now free/i);

    expect(byKey("stepup")[0].body).toEqual({ action: "member.contact_email", targetId: "t-a/m-pat/change", change: { newEmail: "pat.personal@club.example" }, code: "123456" });
    expect(byKey("contact")[0].headers["x-matflow-step-up"]).toBe("grant-member");
    expect(byKey("contact")[0].body).toMatchObject({ newEmail: "pat.personal@club.example", version: "a".repeat(64) });
    expect(String(byKey("contact")[0].body.reason)).toMatch(/call-back to the club number on file/);
    expect(byKey("check")[0].body).toEqual({ email: ADDRESS });
    // Half-way: the resume point is in the URL (ids only) and the address in this tab.
    expect(window.location.search).toContain("resolve=owner");
    expect(window.location.search).toContain("member=m-pat");
    expect(window.location.search).not.toContain("%40");
    expect(screen.getByText(/step 1 done, step 2 not done/i)).toBeTruthy();
    expect(screen.getByText(/works once/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /change the owner's login address/i }));
    fireEvent.change(screen.getByLabelText(/a new authenticator code/i), { target: { value: "654321" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^change login address$/i })); });
    await screen.findByText(/conflict resolved/i);

    expect(byKey("stepup")[1].body).toEqual({ action: "owner.login_email", targetId: "t-a/u-owner/change", change: { newEmail: ADDRESS }, code: "654321" });
    expect(byKey("owner")[0].headers["x-matflow-step-up"]).toBe("grant-owner");
    expect(byKey("owner")[0].body).toMatchObject({ action: "change", newEmail: ADDRESS });
    expect(onOwnerChanged).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByText(/member m-pat/i)).toBeTruthy();
    expect(screen.getByText(/owner u-owner/i)).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("double click on the member step: ONE grant request, ONE change", async () => {
    let release: () => void = () => {};
    script = {
      stepup: [() => new Promise<Response>((r) => { release = () => r(ok({ ok: true, grant: "g" })); })],
      contact: [() => ok({ ok: true, memberId: "m-pat", canSignIn: false })],
      check: [() => ok({ ok: true, ...FREE })],
    };
    renderPanel();
    verify();
    await memberStep();
    const submit = screen.getByRole("button", { name: /^change contact address$/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);
    await act(async () => { release(); });
    await screen.findByText(/the address is now free/i);
    expect(byKey("stepup")).toHaveLength(1);
    expect(byKey("contact")).toHaveLength(1);
  });

  it("lost response: nothing is retried automatically; the operator re-sends the SAME grant (no new code)", async () => {
    script = {
      stepup: [() => ok({ ok: true, grant: "grant-once" })],
      contact: [
        () => Promise.reject(new TypeError("network down")),
        () => ok({ ok: true, alreadyApplied: true, memberId: "m-pat", canSignIn: false, recordedAction: "admin.member.contact_email.changed" }),
      ],
      check: [() => ok({ ok: true, ...FREE })],
    };
    renderPanel();
    verify();
    await memberStep();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^change contact address$/i })); });
    await screen.findByText(/the response was lost/i);
    expect(byKey("contact")).toHaveLength(1); // no automatic retry
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /re-send the same confirmation/i })); });
    await screen.findByText(/the address is now free/i);
    expect(byKey("stepup")).toHaveLength(1);
    expect(byKey("contact")).toHaveLength(2);
    expect(byKey("contact")[1].headers["x-matflow-step-up"]).toBe("grant-once");
    expect(byKey("contact")[1].body).toEqual(byKey("contact")[0].body);
  });

  it("owner step fails: says step 1 done / step 2 not done, keeps the resume point, does not retry", async () => {
    script = {
      stepup: [() => ok({ ok: true, grant: "g1" }), () => ok({ ok: true, grant: "g2" })],
      contact: [() => ok({ ok: true, memberId: "m-pat", canSignIn: true })],
      check: [() => ok({ ok: true, ...FREE })],
      owner: [() => ok({ error: "The change could not be recorded, so nothing was changed." }, 500)],
    };
    const { onOwnerChanged } = renderPanel();
    verify();
    await memberStep();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^change contact address$/i })); });
    await screen.findByText(/the address is now free/i);
    fireEvent.click(screen.getByRole("button", { name: /change the owner's login address/i }));
    fireEvent.change(screen.getByLabelText(/a new authenticator code/i), { target: { value: "654321" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^change login address$/i })); });
    await screen.findAllByText(/could not be recorded/i);
    expect(byKey("owner")).toHaveLength(1);
    expect(onOwnerChanged).not.toHaveBeenCalled();
    expect(screen.getByText(/step 1 done, step 2 not done/i)).toBeTruthy();
    const resume = loadResume("t-a");
    expect(resume.urlMemberId).toBe("m-pat");
    expect(resume.state).toMatchObject({ address: ADDRESS, memberId: "m-pat" });
  });

  it("re-check finds the address still held: blocked, no owner step offered", async () => {
    script = {
      stepup: [() => ok({ ok: true, grant: "g1" })],
      contact: [() => ok({ ok: true, memberId: "m-pat", canSignIn: false })],
      check: [() => ok({ ok: true, ...HELD, holder: { ...HELD.holder!, id: "m-other", name: "Someone Else" } })],
    };
    renderPanel();
    verify();
    await memberStep();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^change contact address$/i })); });
    await screen.findByText(/still held/i);
    expect(screen.queryByRole("button", { name: /change the owner's login address/i })).toBeNull();
  });

  it("a resumed panel (reload after step 1) opens at the owner step when the fresh check is free", async () => {
    renderPanel({ check: FREE, resume: { address: ADDRESS, memberId: "m-pat", member: { memberId: "m-pat", canSignIn: false } } });
    expect(screen.getByText(/step 1 done, step 2 not done/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /change the owner's login address/i })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("a staff holder or a legacy duplicate offers no action", () => {
    renderPanel({ check: { ...HELD, holder: { kind: "user", id: "u-coach", name: "Cole Coach", status: "coach", canSignIn: true, access: "password", link: "/dashboard/staff" } } });
    expect(screen.getByText(/staff account holds this address/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /change this member's contact address/i })).toBeNull();
    cleanup();
    renderPanel({ check: { ...HELD, holder: { kind: "many", count: 2, holders: [] } } });
    expect(screen.getByText(/legacy duplicate/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /change this member's contact address/i })).toBeNull();
  });

  it("loadResume ignores storage that does not match the URL", () => {
    window.sessionStorage.setItem("matflow.hub.resolve.t-a", JSON.stringify({ address: ADDRESS, memberId: "m-other" }));
    window.history.replaceState(null, "", "/admin/tenants/t-a?resolve=owner&member=m-pat");
    expect(loadResume("t-a")).toEqual({ urlMemberId: "m-pat", state: null });
    void waitFor;
  });
});

// Staff-account path, duplicates path and plain record labels (hub conflict
// resolution, 12 Oct 2026, task 4). The step-up mock answers with the REAL
// route's success shape (app/api/admin/auth/step-up/route.ts: { ok, grant,
// expiresAt }) and the grant travels in the real header (x-matflow-step-up);
// the staff route mock answers with that route's shape ({ ok, userId,
// sessionsRevoked: true, retired: { resetCodes, signInLinks } }).
describe("ConflictPanel: staff accounts, duplicates and record labels", () => {
  const user = userEvent.setup();
  const V = "a".repeat(64);
  function renderPanel(over: Partial<{ holder: CheckedHolder; owner: { id: string; name: string } }>) {
    const result = { free: false, tenant: { id: "T", name: "Club" }, owner: over.owner ?? { id: "o1", name: "Owner" }, holder: over.holder };
    return render(
      <ConflictPanel
        tenantId="T"
        ownerUserId={result.owner.id}
        address="owner@club.test"
        check={result as CheckResult}
        onOwnerChanged={() => {}}
        onClose={() => {}}
      />,
    );
  }
  async function verifyAndStart() {
    await user.click(screen.getByRole("checkbox", { name: /verified the relationship independently/i }));
    await user.type(screen.getByLabelText(/How you verified it/), "Call-back to the club's number on file");
  }
  function mockFetchSequence(steps: { url: string; body: unknown; status?: number }[]) {
    // `_init` is declared so mock.calls carries the request options (headers, body).
    const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const s = steps.find((x) => String(input).endsWith(x.url)) ?? steps[0];
      return new Response(JSON.stringify(s.body), { status: s.status ?? 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("labels a member holder as a member record, and notes a shared name is a different record", async () => {
    renderPanel({ holder: { kind: "member", id: "m1", name: "Sean Coates", status: "cancelled", canSignIn: false, access: "none", link: "/x", version: V } , owner: { id: "o1", name: "Sean Coates" } });
    expect(screen.getByText("Member record")).toBeInTheDocument();
    expect(screen.getByText("Member (gym customer)")).toBeInTheDocument();
    expect(screen.getByText(/different record from the owner's sign-in account/)).toBeInTheDocument();
  });

  it("offers the staff path instead of a dead end, and warns the person will be signed out", async () => {
    renderPanel({ holder: { kind: "user", id: "u1", name: "Pat", status: "manager", canSignIn: true, access: "password", link: "/dashboard/staff", version: V } });
    expect(screen.getByText("Club sign-in account")).toBeInTheDocument();
    expect(screen.getByText("Staff account (manager)")).toBeInTheDocument();
    expect(screen.queryByText(/changed by the club in Staff settings/)).toBeNull();
    await verifyAndStart(); // ticks the call-back checkbox and fills the note; the lines below click the button
    expect(screen.getByRole("button", { name: "Change this staff account's login address" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Change this staff account's login address" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/Pat will be signed out everywhere/);
    // What "unverified" means for them (final review R13), as the sign-in doors enforce it.
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "While it is unverified, password-reset codes, emailed sign-in links and Google sign-in do not work for them; if they forget their password, the club owner sets a temporary one in Staff settings.",
    );
  });

  it("posts the staff move to the staff route with the step-up header, then re-checks", async () => {
    const fetchMock = mockFetchSequence([
      { url: "/api/admin/auth/step-up", body: { ok: true, grant: "GRANT", expiresAt: "2026-10-12T12:05:00.000Z" } },
      { url: "/api/admin/customers/T/staff/u1/login-email", body: { ok: true, userId: "u1", sessionsRevoked: true, retired: { resetCodes: 0, signInLinks: 0 } } },
      { url: "/api/admin/customers/T/login-email/check", body: { ok: true, free: true, tenant: { id: "T", name: "Club" }, owner: { id: "o1", name: "Owner" } } },
    ]);
    renderPanel({ holder: { kind: "user", id: "u1", name: "Pat", status: "manager", canSignIn: true, access: "password", link: "/dashboard/staff", version: V } });
    await verifyAndStart();
    await user.click(screen.getByRole("button", { name: "Change this staff account's login address" }));
    await user.type(screen.getByLabelText(/new login address/i), "pat.manager@club.test");
    await user.type(screen.getByLabelText(/reason/i), "Club confirmed by call-back");
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^Change login address$/ }));
    const calls = fetchMock.mock.calls.map(([u, init]) => ({ u: String(u), h: new Headers((init as RequestInit)?.headers) }));
    const move = calls.find((c) => c.u.endsWith("/staff/u1/login-email"))!;
    expect(move.h.get("x-matflow-step-up")).toBe("GRANT");
    expect(calls.at(-1)!.u).toMatch(/\/login-email\/check$/);
    // The grant is asked for THIS action, THIS account and THIS new address,
    // and the move carries the version the check returned.
    const bodies = fetchMock.mock.calls.map(([u, init]) => ({ u: String(u), b: JSON.parse(String((init as RequestInit).body)) }));
    expect(bodies.find((c) => c.u.endsWith("/auth/step-up"))!.b).toEqual({
      action: "staff.login_email", targetId: "T/u1/change", change: { newEmail: "pat.manager@club.test" }, code: "123456",
    });
    expect(bodies.find((c) => c.u.endsWith("/staff/u1/login-email"))!.b).toEqual({
      newEmail: "pat.manager@club.test", reason: expect.stringMatching(/Club confirmed by call-back$/), version: V,
    });
    await screen.findByText(/the address is now free/i);
    expect(window.location.search).toContain("staff=u1");
    expect(window.location.search).not.toContain("member=");
  });

  it("lists every holder of a duplicate, each with its own move button, and keeps the owner step closed until free", async () => {
    renderPanel({ holder: { kind: "many", count: 2, holders: [
      { kind: "member", id: "m1", name: "A", status: "active", canSignIn: true, access: "password", link: "/m1", version: V },
      { kind: "user", id: "u1", name: "B", status: "coach", canSignIn: true, access: "password", link: "/dashboard/staff", version: V },
    ] } });
    expect(screen.getAllByRole("button", { name: /Change this (member's contact|staff account's login) address/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Change the owner's login address" })).toBeNull();
  });

  // Final review R13 (12 Oct 2026): a second owner row as the holder. The check
  // gives it no version and the staff route refuses it, so the panel must not
  // show staff wording, a dead staff button or "Check the address again".
  const OWNER_NOTICE =
    "Another owner account in this club uses this address. Owner accounts are not changed from here; contact MatFlow support.";
  const secondOwner = { kind: "user" as const, id: "u2", name: "Second Owner", status: "owner", canSignIn: true, access: "password" as const, link: "/dashboard/staff" };

  it("an owner-role holder gets a clear notice, not the staff move path", () => {
    renderPanel({ holder: secondOwner });
    expect(screen.getByText("Owner account")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(OWNER_NOTICE);
    expect(screen.queryByText(/staff account holds this address/i)).toBeNull();
    expect(screen.queryByText(/check the address again/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Change this (member's contact|staff account's login) address/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change the owner's login address" })).toBeNull();
  });

  it("a duplicate with an owner-role holder: the notice on that row, a move button only for the other record", () => {
    renderPanel({ holder: { kind: "many", count: 2, holders: [
      { kind: "member", id: "m1", name: "A", status: "active", canSignIn: true, access: "password", link: "/m1", version: V },
      secondOwner,
    ] } });
    const rows = within(screen.getByRole("list", { name: "Records holding this address" })).getAllByRole("listitem");
    expect(rows[0]).not.toHaveTextContent(OWNER_NOTICE);
    expect(within(rows[0]).getByRole("button", { name: "Change this member's contact address" })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent(OWNER_NOTICE);
    expect(within(rows[1]).queryByRole("button")).toBeNull();
    expect(rows[1]).not.toHaveTextContent(/check the address again/i);
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("duplicate: after one move the re-check still reports a holder, so the list returns; once free, the owner step opens", async () => {
    const holderB = { kind: "user" as const, id: "u1", name: "B", status: "coach", canSignIn: true, access: "password" as const, link: "/dashboard/staff", version: V };
    let checks = 0;
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      const body = u.endsWith("/auth/step-up")
        ? { ok: true, grant: "GRANT", expiresAt: "2026-10-12T12:05:00.000Z" }
        : u.endsWith("/members/m1/contact-email")
          ? { ok: true, memberId: "m1", canSignIn: true, retired: { resetCodes: 0, signInLinks: 0 } }
          : u.endsWith("/staff/u1/login-email")
            ? { ok: true, userId: "u1", sessionsRevoked: true, retired: { resetCodes: 0, signInLinks: 0 } }
            : ++checks === 1
              ? { ok: true, free: false, tenant: { id: "T", name: "Club" }, owner: { id: "o1", name: "Owner" }, holder: holderB }
              : { ok: true, free: true, tenant: { id: "T", name: "Club" }, owner: { id: "o1", name: "Owner" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);
    renderPanel({ holder: { kind: "many", count: 2, holders: [
      { kind: "member", id: "m1", name: "A", status: "active", canSignIn: true, access: "password", link: "/m1", version: V },
      holderB,
    ] } });
    await verifyAndStart();
    await user.click(screen.getByRole("button", { name: "Change this member's contact address" }));
    await user.type(screen.getByLabelText(/new contact address/i), "a.personal@club.test");
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^Change contact address$/ }));
    // Still held (by B): the list again, never the owner step.
    expect(await screen.findByRole("button", { name: "Change this staff account's login address" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Change the owner's login address" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change this staff account's login address" }));
    await user.type(screen.getByLabelText(/new login address/i), "b.coach@club.test");
    await user.type(screen.getByLabelText(/authenticator code/i), "654321");
    await user.click(screen.getByRole("button", { name: /^Change login address$/ }));
    expect(await screen.findByRole("button", { name: "Change the owner's login address" })).toBeInTheDocument();
    expect(window.location.search).toContain("member=m1");
    expect(window.location.search).toContain("staff=u1");
  });

  // Review fix round 1 (task-4-review.md, Important 1 + ruling R10).
  it("a resumed duplicate that is still held lists the remaining holders with their move buttons, keeps the owner step closed and the resume trail", async () => {
    const tenant = { id: "T", name: "Club" };
    const owner = { id: "o1", name: "Owner" };
    const m1 = { kind: "member" as const, id: "m1", name: "A", status: "active", canSignIn: true, access: "password" as const, link: "/m1", version: V };
    const u1 = { kind: "user" as const, id: "u1", name: "B", status: "coach", canSignIn: true, access: "password" as const, link: "/dashboard/staff", version: V };
    window.history.replaceState(null, "", "/admin/tenants/T?resolve=owner&member=m0");
    const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const u = String(input);
      const body = u.endsWith("/auth/step-up")
        ? { ok: true, grant: "GRANT", expiresAt: "2026-10-12T12:05:00.000Z" }
        : u.endsWith("/staff/u1/login-email")
          ? { ok: true, userId: "u1", sessionsRevoked: true, retired: { resetCodes: 0, signInLinks: 0 } }
          : { ok: true, free: false, tenant, owner, holder: m1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);
    render(
      <ConflictPanel
        tenantId="T"
        ownerUserId="o1"
        address="owner@club.test"
        check={{ free: false, tenant, owner, holder: { kind: "many", count: 2, holders: [m1, u1] } }}
        resume={{ address: "owner@club.test", memberId: "m0", member: { memberId: "m0", canSignIn: false } }}
        onOwnerChanged={() => {}}
        onClose={() => {}}
      />,
    );
    // Not a dead end: the remaining holders are listed, each with its move button.
    expect(screen.getAllByRole("button", { name: /Change this (member's contact|staff account's login) address/ })).toHaveLength(2);
    expect(screen.getByText("2 records in this club (listed below)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change the owner's login address" })).toBeNull();
    // Plain progress copy (R10), never "step 1 done" while records still hold the address.
    expect(screen.getByText("Moved 1 of 3 records. 2 records still use this address — move them below, then change the owner's login address.")).toBeInTheDocument();
    expect(screen.queryByText(/step 1 done/i)).toBeNull();
    expect(fn).not.toHaveBeenCalled();

    // Move the staff account: the re-check still finds the member, so the
    // review step returns with that holder, and the trail keeps member=m0.
    await verifyAndStart();
    await user.click(screen.getByRole("button", { name: "Change this staff account's login address" }));
    await user.type(screen.getByLabelText(/new login address/i), "b.coach@club.test");
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^Change login address$/ }));
    expect(await screen.findByRole("button", { name: "Change this member's contact address" })).toBeInTheDocument();
    expect(screen.getByText(/still held/i)).toBeInTheDocument();
    expect(screen.getByText("Moved 2 of 3 records. 1 record still uses this address — move it below, then change the owner's login address.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change the owner's login address" })).toBeNull();
    expect(window.location.search).toContain("member=m0");
    expect(window.location.search).toContain("staff=u1");
    expect(JSON.parse(window.sessionStorage.getItem("matflow.hub.resolve.T") ?? "{}")).toMatchObject({ memberId: "m0", staffId: "u1" });
  });

  it("a staff-only resume (URL has only &staff=) re-checks and, when free, offers the owner step", async () => {
    const tenant = { id: "T", name: "Club" };
    const owner = { id: "o1", name: "Owner" };
    window.sessionStorage.setItem("matflow.hub.resolve.T", JSON.stringify({ address: "owner@club.test", staffId: "u1", staffName: "Pat", staff: { userId: "u1" } }));
    window.history.replaceState(null, "", "/admin/tenants/T?resolve=owner&staff=u2");
    expect(loadResume("T")).toMatchObject({ urlMemberId: null, urlStaffId: "u2", state: null }); // storage for another account is ignored
    window.history.replaceState(null, "", "/admin/tenants/T?resolve=owner&staff=u1");
    expect(loadResume("T")).toMatchObject({ urlMemberId: null, urlStaffId: "u1", state: { address: "owner@club.test", staffId: "u1" } });

    const fn = mockFetchSequence([{ url: "/api/admin/customers/T/login-email/check", body: { ok: true, free: true, tenant, owner } }]);
    render(<LoginEmailCard tenantId="T" ownerUserId="o1" ownerName="Owner" ownerEmail="old@club.test" provisionalSince={null} emailDelivery="off" />);
    expect(await screen.findByRole("button", { name: "Change the owner's login address" })).toBeInTheDocument();
    expect(fn).toHaveBeenCalledTimes(1); // one read; nothing is re-sent
    expect(String(fn.mock.calls[0][0])).toMatch(/\/api\/admin\/customers\/T\/login-email\/check$/);
    expect(JSON.parse(String(fn.mock.calls[0][1]?.body))).toEqual({ email: "owner@club.test" });
    expect(
      screen.getByText(/Step 1 done, step 2 not done\. The staff account's login address was changed \(staff account u1\)\. The owner's login address has not been changed yet\./),
    ).toBeInTheDocument();
  });
});
