// @vitest-environment jsdom
//
// The Categories sheet against a stand-in for the category routes that keeps real versions, as the server does: a
// rename, archive or restore carries the version the person saw, a reorder bumps the rows it moves. Faults: a
// reorder's answer held back (it is saved at once), or dropped (saved, never answered). B3-1 (review round 3).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { CategoriesSheet } from "@/components/dashboard/CategoriesSheet";

type Row = { id: string; name: string; legacyKey: string | null; archived: boolean; version: number; classCount: number; sortOrder: number };
type Call = { method: string; url: string; body: Record<string, unknown> | undefined; status?: number };

let rows: Row[] = [];
let calls: Call[] = [];
let orderFault: null | "hold" | "lose" = null;
let releaseHeld: (() => void) | null = null;
/** When set, the next category list read after a reorder waits until released (a slow reload). */
let holdReload = false;
let releaseReload: (() => void) | null = null;

const STALE_ONE = "This category was changed in another tab or by someone else. Close this and open Categories again.";
const STALE_ALL = "Your categories have changed. Close this and open Categories again.";
const list = () => [...rows].sort((a, b) => a.sortOrder - b.sortOrder).map(({ sortOrder: _s, ...r }) => ({ ...r }));
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const refuse = (status: number, data: unknown) => ({ ok: false, status, json: async () => data, text: async () => JSON.stringify(data) });

/** Another admin's rename, straight at the "server". */
const otherAdminRenames = (id: string, name: string) => {
  const r = rows.find((x) => x.id === id)!;
  r.name = name;
  r.version++;
};

beforeEach(() => {
  calls = [];
  orderFault = null;
  releaseHeld = null;
  holdReload = false;
  releaseReload = null;
  rows = ["Kids", "Beginners", "Gi", "No-Gi", "Competition", "Open Mat"].map((name, i) => ({ id: `c${i}`, name, legacyKey: null, archived: false, version: 3, classCount: 0, sortOrder: i * 10 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      const call: Call = { method, url, body };
      calls.push(call);
      if (method === "GET" && url.startsWith("/api/class-categories")) {
        if (holdReload && calls.some((c) => c.method === "PUT" && c.status === 200)) { holdReload = false; await new Promise<void>((res) => { releaseReload = res; }); }
        return ok({ categories: list(), managementEnabled: true });
      }
      if (method === "PUT" && url === "/api/class-categories/order") {
        const items = body!.items as { id: string; version: number }[];
        const same = items.length === rows.length && items.every((i) => rows.find((r) => r.id === i.id)?.version === i.version);
        if (!same) { call.status = 409; return refuse(409, { error: STALE_ALL, code: "stale" }); }
        const moved: { id: string; version: number }[] = [];
        items.forEach((it, i) => {
          const r = rows.find((x) => x.id === it.id)!;
          if (r.sortOrder !== i) { r.sortOrder = i; r.version++; moved.push({ id: r.id, version: r.version }); }
        });
        call.status = 200;
        const answer = ok({ ok: true, changed: moved.length > 0, moved });
        if (orderFault === "lose") throw new TypeError("Failed to fetch");
        if (orderFault === "hold") await new Promise<void>((res) => { releaseHeld = res; });
        return answer;
      }
      const m = /^\/api\/class-categories\/([^/]+)$/.exec(url);
      if (method === "PATCH" && m) {
        const r = rows.find((x) => x.id === m[1])!;
        if (r.version !== body!.version) { call.status = 409; return refuse(409, { error: STALE_ONE, code: "stale" }); }
        if (typeof body!.name === "string") r.name = body!.name;
        if (typeof body!.archived === "boolean") r.archived = body!.archived;
        r.version++;
        call.status = 200;
        return ok({ id: r.id, name: r.name, archived: r.archived, version: r.version });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async () => {
  render(<CategoriesSheet open onClose={() => {}} onChanged={() => {}} />);
  await screen.findByLabelText("Kids name");
};
const rename = (from: string, to: string) => {
  const field = screen.getByLabelText(`${from} name`) as HTMLInputElement;
  fireEvent.change(field, { target: { value: to } });
  fireEvent.keyDown(field, { key: "Enter" });
};
const moveDown = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Move ${name} down` }));
const patches = () => calls.filter((c) => c.method === "PATCH");
const names = () => list().filter((r) => !r.archived).map((r) => r.name);

describe("Categories sheet: the version a write carries (B3-1)", () => {
  it("reorder, then a rename of a row it moved while its answer is held: both land; the rename counts the reorder's own bump", async () => {
    await open();
    orderFault = "hold";
    moveDown("Beginners");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    rename("Beginners", "Beginners (Tue)");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(patches()).toHaveLength(0); // the rename waits for the reorder
    await act(async () => { releaseHeld!(); });
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(names()).toEqual(["Kids", "Gi", "Beginners (Tue)", "No-Gi", "Competition", "Open Mat"]));
    expect(patches()[0].status).toBe(200);
  });

  it("two admins: a rename waiting behind a reorder is refused when the other admin renamed the same row meanwhile; theirs is kept", async () => {
    await open();
    orderFault = "hold";
    moveDown("Kids");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    rename("Competition", "Competition (mine)");
    otherAdminRenames("c4", "Competition (theirs)");
    await act(async () => { releaseHeld!(); });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].status).toBe(409);
    expect(rows.find((r) => r.id === "c4")!.name).toBe("Competition (theirs)");
    await screen.findByText(STALE_ONE);
  });

  it("a lost reorder answer: the sheet says so and shows what is saved; a retry and then a rename land", async () => {
    await open();
    orderFault = "lose";
    moveDown("Competition");
    await screen.findByText(/Couldn't confirm that move/);
    expect(names()).toEqual(["Kids", "Beginners", "Gi", "No-Gi", "Open Mat", "Competition"]);
    await waitFor(() => expect(screen.getAllByRole("textbox").map((e) => (e as HTMLInputElement).value).slice(0, 6)).toEqual(names()));
    orderFault = null;
    // The retry: the first row moves down one.
    moveDown("Kids");
    await waitFor(() => expect(names()[1]).toBe("Kids"));
    await waitFor(() => expect(screen.getAllByRole("textbox").map((e) => (e as HTMLInputElement).value).slice(0, 6)).toEqual(names()));
    rename("Competition", "Competition Team");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect({ status: patches()[0].status, sent: patches()[0].body!.version, server: rows.find((r) => r.id === "c4")!.version }).toMatchObject({ status: 200 });
    expect(names()).toContain("Competition Team");
  });

  it("the journey's sequence: a lost answer moving Competition, a retry moving Competition again, then renaming Competition: lands", async () => {
    await open();
    orderFault = "lose";
    moveDown("Competition");
    await screen.findByText(/Couldn't confirm that move/);
    orderFault = null;
    await waitFor(() => expect(screen.getAllByRole("textbox").map((e) => (e as HTMLInputElement).value).slice(0, 6)).toEqual(names()));
    moveDown("Competition");
    // As the journey does: start typing as soon as the database shows the retry, before the sheet has its answer.
    await waitFor(() => expect(names().indexOf("Competition")).toBe(5));
    rename("Competition", "Competition Team");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect({ status: patches()[0].status, sent: patches()[0].body!.version, server: rows.find((r) => r.id === "c4")!.version - (patches()[0].status === 200 ? 1 : 0) }).toEqual({ status: 200, sent: rows.find((r) => r.id === "c4")!.version - 1, server: rows.find((r) => r.id === "c4")!.version - 1 });
  });

  it("a rename begun after a reorder's answer but before its slow reload lands, on a row it moved: lands (the journey's B15 window)", async () => {
    await open();
    holdReload = true;
    moveDown("Competition");
    await waitFor(() => expect(releaseReload).not.toBeNull());
    // Typed after the reorder's answer was counted, while the reload is still out: the rename waits for it.
    rename("Competition", "Competition Team");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(patches()).toHaveLength(0);
    await act(async () => { releaseReload!(); });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].status).toBe(200);
    expect(names()).toContain("Competition Team");
  });

  it("a rename begun while a lost-answer reorder is in flight, on a row it moved, is refused, never applied over an unaccounted version", async () => {
    await open();
    orderFault = "lose";
    let lose!: () => void;
    const gate = new Promise<void>((r) => { lose = r; });
    const realFetch = global.fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => { if ((i?.method ?? "GET") === "PUT") { await gate; } return realFetch(u, i); }));
    moveDown("Gi");
    rename("Gi", "Gi (Mon)");
    await act(async () => { lose(); });
    await waitFor(() => expect(patches().length + calls.filter((c) => c.method === "PUT").length).toBeGreaterThan(1));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].status).toBe(409);
    expect(rows.find((r) => r.id === "c2")!.name).toBe("Gi");
    // It was this person's own unconfirmed move, and the sheet says so (N3).
    await screen.findByText(/Your earlier move wasn't confirmed/);
  });

  it("a rename cancelled with Escape leaves nothing behind: after another admin's rename is shown, a new rename lands (S1)", async () => {
    await open();
    const field = screen.getByLabelText("Gi name") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Gi (draft)" } });
    fireEvent.keyDown(field, { key: "Escape" });
    // A move elsewhere is saved; before its reload lands, the other admin renames Gi; the reload then shows it, with
    // no conflict on the way (a conflict would clear everything and hide the defect).
    holdReload = true;
    moveDown("No-Gi");
    await waitFor(() => expect(releaseReload).not.toBeNull());
    otherAdminRenames("c2", "Gi Adults");
    await act(async () => { releaseReload!(); });
    await screen.findByLabelText("Gi Adults name");
    expect(screen.queryByText(STALE_ONE)).toBeNull();
    rename("Gi Adults", "Gi Adults (Mon)");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].status).toBe(200);
  });

  it("a move that waited for a rename which was then refused does not go ahead (B3-7)", async () => {
    await open();
    const field = screen.getByLabelText("Kids name") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Kids (Sat)" } });
    otherAdminRenames("c0", "Kids Club");
    fireEvent.keyDown(field, { key: "Enter" });
    moveDown("Gi");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].status).toBe(409);
    await screen.findByText(STALE_ONE);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});
