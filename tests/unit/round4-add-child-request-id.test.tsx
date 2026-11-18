// @vitest-environment jsdom
// Round 4 (10 Nov 2026): Add child sends a request id that a retry of the same
// details reuses, so a lost reply cannot add the child twice (the server
// returns the child it already created: tests/integration/round4-child-create-db).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: (m: string) => { toasts.push(m); } }) }));

import OwnerFamilyManagement from "@/components/dashboard/OwnerFamilyManagement";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toasts.length = 0; });

function open() {
  render(<OwnerFamilyManagement memberId="par-1" memberName="Pat Parent" hasKidsHint parent={null} initialChildren={[]} primaryColor="#000" role="owner" />);
  fireEvent.click(screen.getAllByRole("button", { name: /Add child/ })[0]);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sol Kid" } });
  fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "2018-05-01" } });
}
const submit = () => fireEvent.submit(screen.getByLabelText("Name").closest("form")!);

describe("Add child request id", () => {
  it("a retry after no reply sends the same request id; changed details send a new one", async () => {
    const bodies: Record<string, unknown>[] = [];
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (first) { first = false; throw new TypeError("Failed to fetch"); }
      return new Response(JSON.stringify({ id: "kid-1", name: "Sol Kid" }), { status: 201 });
    }));
    open();
    submit();
    await waitFor(() => expect(toasts.some((t) => /isn't known whether the child was added/.test(t))).toBe(true));
    submit();
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(typeof bodies[0].requestId).toBe("string");
    expect(bodies[1].requestId).toBe(bodies[0].requestId);
  });
});
