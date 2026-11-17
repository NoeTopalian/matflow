// @vitest-environment jsdom
//
// Round 11 (baseline 6.1): one stray tap on the scrim, Escape or the header close button threw away a half-filled
// overlay form. With `confirmDiscard` set (the caller's form differs from what it opened with), each of those asks
// "Discard your changes?" first; "Keep editing" keeps the form, "Discard changes" closes it. A clean form still closes
// at once, and the caller's own Cancel is never intercepted.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React, { useState } from "react";

import { Sheet } from "@/components/ui/sheet";
import { Dialog } from "@/components/ui/dialog";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function Harness({ dirty, onClose, Overlay = Sheet }: { dirty: boolean; onClose: () => void; Overlay?: typeof Sheet }) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("Half-built class");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <Overlay
        open={open}
        title="New class"
        confirmDiscard={dirty}
        onClose={() => { onClose(); setOpen(false); }}
        footer={<button type="button" onClick={() => { onClose(); setOpen(false); }}>Cancel</button>}
      >
        <label htmlFor="n">Class Name</label>
        <input id="n" value={text} onChange={(e) => setText(e.target.value)} />
      </Overlay>
    </>
  );
}

const scrim = (slot = "sheet") => document.querySelector(`[data-slot="${slot}-scrim"]`) as HTMLElement;
const question = () => screen.queryByRole("dialog", { name: "Discard your changes?" });

async function mount(dirty: boolean, Overlay: typeof Sheet = Sheet) {
  const onClose = vi.fn();
  render(<Harness dirty={dirty} onClose={onClose} Overlay={Overlay} />);
  await act(async () => {});
  return onClose;
}

describe("overlay discard guard", () => {
  it("a scrim tap on an unsaved form asks first; Keep editing keeps the form and its text", async () => {
    const onClose = await mount(true);
    fireEvent.click(scrim());
    expect(question()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // The safe answer has focus.
    expect(document.activeElement?.textContent).toBe("Keep editing");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(question()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Half-built class");
  });

  it("Escape asks too; a second Escape answers the question (keep editing), not the form", async () => {
    const onClose = await mount(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(question()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(question()).toBeNull();
    expect(screen.getByRole("dialog", { name: "New class" })).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the header close button asks; Discard changes closes the form", async () => {
    const onClose = await mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(question()).toBeNull();
    expect(screen.queryByRole("dialog", { name: "New class" })).toBeNull();
  });

  it("a scrim tap on the question itself keeps editing", async () => {
    const onClose = await mount(true);
    fireEvent.click(scrim());
    fireEvent.click(document.querySelectorAll('[data-slot="dialog-scrim"]')[0] as HTMLElement);
    expect(question()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a form with nothing changed closes at once: no question", async () => {
    const onClose = await mount(false);
    fireEvent.click(scrim());
    expect(question()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the caller's own Cancel is an explicit choice and is never intercepted", async () => {
    const onClose = await mount(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(question()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Dialog has the same guard", async () => {
    const onClose = await mount(true, Dialog);
    fireEvent.click(scrim("dialog"));
    expect(question()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
