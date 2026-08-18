// @vitest-environment jsdom
//
// Regression tests for the close-guard class of bug (docs/UI-RULES.md §4a.3).
//
// Every guarded overlay reads a busy flag to decide whether Escape, the scrim,
// the header X and Cancel are allowed to dismiss it. That is only safe if the
// flag is released on EVERY path — a rejected request that strands the flag
// turns the guard into a permanently unclosable modal. RemoveMemberModal
// shipped exactly that on the member-delete flow, so it gets the test.
//
// Also here: `lockScroll`'s nesting behaviour, and the DataTable dev-time
// warning for the clipping ancestor that makes its sticky <thead> inert.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";

import { RemoveMemberModal } from "@/components/dashboard/RemoveMemberModal";
import { ToastProvider } from "@/components/ui/Toast";
import { lockScroll } from "@/components/ui/overlay";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

// The router object must be STABLE across renders: RemoveMemberModal's probe
// effect lists `router` in its deps, so a fresh object per call re-runs the
// effect on every render and spins forever.
vi.mock("next/navigation", () => {
  const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
  return { useRouter: () => router };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

/** Probe resolves "no linked kids"; the destructive DELETE runs `onDelete`. */
function mockFetch(onDelete: () => Promise<Response>) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes("probe=1")) {
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ noKids: true }),
      } as unknown as Response);
    }
    return onDelete();
  }) as unknown as typeof fetch;
}

function renderModal(onClose = vi.fn()) {
  render(
    <ToastProvider>
      <RemoveMemberModal
        memberId="m1"
        memberName="Ana Silva"
        open
        onClose={onClose}
        primaryColor="#3b82f6"
      />
    </ToastProvider>,
  );
  return onClose;
}

describe("RemoveMemberModal close guard", () => {
  it("stays closable and explains itself when the DELETE rejects", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    const onClose = renderModal();

    // Let the probe settle so the confirm phase renders.
    await act(async () => {});
    const confirm = screen.getByRole("button", { name: /remove permanently/i });

    await act(async () => {
      fireEvent.click(confirm);
    });

    // The failure is visible…
    expect(screen.getByText(/check your connection/i)).toBeTruthy();
    // …and every exit works again: the busy flag was released in `finally`.
    const cancel = screen.getByRole("button", { name: /^cancel$/i }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("stays closable when the server answers a 200 with an unparseable body", async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      } as unknown as Response),
    );
    const onClose = renderModal();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /remove permanently/i }));
    });

    // A 200 means the member IS gone, so this is the success path — the modal
    // must not claim failure, but it must still be dismissible.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("still blocks every exit while the DELETE is genuinely in flight", async () => {
    // Never settles: the request is mid-flight for the whole test.
    mockFetch(() => new Promise<Response>(() => {}));
    const onClose = renderModal();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /remove permanently/i }));
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /^cancel$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not leave the spinner up forever when the probe itself rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const onClose = renderModal();
    await act(async () => {});

    expect(screen.getByText(/couldn't check for linked kids/i)).toBeTruthy();
    // The destructive action is withheld — we never learned whether this
    // member has kids, so ?confirm=1 would be a blind request.
    expect(screen.queryByRole("button", { name: /remove permanently/i })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("lockScroll", () => {
  it("survives a non-LIFO release when two overlays are stacked", () => {
    // `document.body` is locked unconditionally by every overlay, so it is the
    // element two stacked overlays always share. Snapshotting per-overlay meant
    // the second saved the "hidden" the first had just written, and closing out
    // of order left the page unscrollable until a reload.
    const releaseA = lockScroll(null);
    const releaseB = lockScroll(null);
    expect(document.body.style.overflow).toBe("hidden");

    releaseA();
    expect(document.body.style.overflow).toBe("hidden"); // B still holds it

    releaseB();
    expect(document.body.style.overflow).toBe("");
  });

  it("ignores a double-invoked release", () => {
    const releaseA = lockScroll(null);
    const releaseB = lockScroll(null);
    releaseA();
    releaseA();
    expect(document.body.style.overflow).toBe("hidden");
    releaseB();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("DataTable sticky-header guard", () => {
  const columns: DataTableColumn<{ id: string }>[] = [
    { key: "id", header: "Ref", cell: (r) => r.id },
  ];
  const rows = [{ id: "a" }, { id: "b" }];

  it("warns when a clipping ancestor makes the sticky <thead> inert", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <div style={{ overflowX: "hidden", overflowY: "hidden" }}>
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      </div>,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sticky <thead> is inert"),
      expect.anything(),
    );
  });

  it("is quiet when the nearest scroll container is a real scrollport", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <div style={{ overflowY: "auto" }}>
        <div style={{ overflowX: "hidden", overflowY: "hidden" }} />
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      </div>,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
