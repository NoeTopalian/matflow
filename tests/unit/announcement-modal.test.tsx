// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React, { createRef } from "react";
import AnnouncementModal from "@/components/member/AnnouncementModal";

const ANNOUNCEMENT = {
  id: "1",
  title: "Test Announcement",
  body: "This is the body text.",
  time: "1h ago",
  pinned: false,
};

describe("AnnouncementModal a11y", () => {
  beforeEach(() => {
    // Reset body overflow before each test
    document.body.style.overflow = "";
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("1. ESC key closes the modal", () => {
    const onClose = vi.fn();
    render(<AnnouncementModal announcement={ANNOUNCEMENT} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("2. Close button closes the modal", () => {
    const onClose = vi.fn();
    render(<AnnouncementModal announcement={ANNOUNCEMENT} onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("3. Backdrop click closes the modal", () => {
    const onClose = vi.fn();
    const { container } = render(
      <AnnouncementModal announcement={ANNOUNCEMENT} onClose={onClose} />
    );
    // The backdrop is the first child of the fixed container (aria-hidden div)
    const backdrop = container.querySelector("[aria-hidden='true']");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("4. Close button receives focus on mount", () => {
    render(<AnnouncementModal announcement={ANNOUNCEMENT} onClose={() => {}} />);
    const closeBtn = screen.getByRole("button", { name: /close/i });
    expect(document.activeElement).toBe(closeBtn);
  });

  it("5. Focus returns to triggerRef on unmount", () => {
    const triggerEl = document.createElement("button");
    document.body.appendChild(triggerEl);
    triggerEl.focus = vi.fn();

    const triggerRef = createRef<HTMLElement | null>();
    // Assign the element to the ref
    Object.defineProperty(triggerRef, "current", {
      value: triggerEl,
      writable: true,
    });

    const { unmount } = render(
      <AnnouncementModal
        announcement={ANNOUNCEMENT}
        onClose={() => {}}
        triggerRef={triggerRef}
      />
    );
    unmount();
    expect(triggerEl.focus).toHaveBeenCalled();

    document.body.removeChild(triggerEl);
  });

  it("6. Body scroll is locked while open and restored on unmount", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <AnnouncementModal announcement={ANNOUNCEMENT} onClose={() => {}} />
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("7. Dialog has correct ARIA attributes", () => {
    render(<AnnouncementModal announcement={ANNOUNCEMENT} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    // The labelledby ID should point to a visible heading
    const labelId = dialog.getAttribute("aria-labelledby")!;
    const heading = document.getElementById(labelId);
    expect(heading).toBeTruthy();
    expect(heading!.textContent).toContain("Test Announcement");
  });

  it("renders nothing when announcement is null", () => {
    const { container } = render(
      <AnnouncementModal announcement={null} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });
});
