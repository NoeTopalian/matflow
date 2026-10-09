// @vitest-environment jsdom
// Guided conflict resolution UI (admin hub lane F, 9 Oct 2026; AH-04 / I3).
// components/admin/ConflictPanel.tsx against a scripted fetch: the order of
// requests, what each carries, the double-click guard, the lost-response
// re-send of the SAME grant (never an automatic retry), the honest partial
// state with a resume point in the URL, and the resumed panel.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import React from "react";
import ConflictPanel, { loadResume, type CheckResult } from "@/components/admin/ConflictPanel";

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
    renderPanel({ check: { ...HELD, holder: { kind: "many", count: 2 } } });
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
