// @vitest-environment jsdom
//
// The printable member ID card sheet. Every case here is a failure state that
// laminates silently if it is not surfaced BEFORE the sheet is cut up:
//
//   - a member with no photo prints a monogram, and that is not a problem, so
//     no banner is shown;
//   - a photo that FAILS TO LOAD also prints a monogram, but it is a different
//     fact and must be counted — otherwise a systemic 401 from /api/blob-image
//     reads as "nobody uploaded a picture";
//   - a member with no rank prints an explicit ungraded state, never a white
//     belt, because the importer carries no rank data and a laminated card
//     asserting a grade nobody awarded is a factual misstatement;
//   - a tenant with no logo prints the club name as text, never an empty
//     <img>.
//
// QR generation is mocked so the tests drive the component's branching rather
// than the qrcode library.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const toDataURL = vi.fn(async (text: string) => `data:image/png;base64,QR(${text})`);

// Two distinct failure modes, and the component branches differently on each:
// `toDataURL` rejecting is a PER-MEMBER failure, while the dynamic
// `import("qrcode")` failing outright means no card on the sheet can carry a
// working code. The second is simulated by throwing from the namespace's
// `default` getter, which is the same expression the component awaits and
// therefore lands in the same catch.
let moduleLoadFails = false;

vi.mock("qrcode", () => ({
  get default() {
    if (moduleLoadFails) throw new Error("qrcode failed to load");
    return { toDataURL: (...args: unknown[]) => toDataURL(...(args as [string])) };
  },
}));

import {
  MemberCardSheet,
  type PrintCardClub,
  type PrintCardMember,
} from "@/components/print/MemberCardSheet";

afterEach(() => {
  cleanup();
  moduleLoadFails = false;
  toDataURL.mockClear();
  toDataURL.mockImplementation(async (text: string) => `data:image/png;base64,QR(${text})`);
});

const CLUB: PrintCardClub = {
  name: "Total BJJ",
  logoUrl: "https://store1.blob.vercel-storage.com/logo.webp",
};

function member(overrides: Partial<PrintCardMember> = {}): PrintCardMember {
  return {
    id: "m-1",
    name: "Ana Costa",
    cardToken: "token-m-1",
    photoUrl: null,
    rank: { name: "Blue Belt", color: "blue", stripes: 2, maxStripes: 4 },
    ...overrides,
  };
}

async function renderSheet(members: PrintCardMember[], club: PrintCardClub = CLUB) {
  render(<MemberCardSheet club={club} members={members} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /print/i })).toBeTruthy());
}

describe("photos", () => {
  it("renders a monogram and NO failure banner when the member has no photo", async () => {
    await renderSheet([member({ photoUrl: null })]);

    expect(screen.getByTestId("monogram-m-1").textContent).toBe("AC");
    expect(screen.queryByTestId("photo-m-1")).toBeNull();
    expect(screen.queryByTestId("photo-failure-banner")).toBeNull();
  });

  it("routes a stored blob URL through the authenticated image proxy", async () => {
    await renderSheet([
      member({ photoUrl: "https://store1.blob.vercel-storage.com/members/m-1.webp" }),
    ]);

    const img = screen.getByTestId("photo-m-1") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/api/blob-image?url=");
  });

  it("falls back to the monogram AND counts the failure when a photo does not load", async () => {
    await renderSheet([
      member({ photoUrl: "https://store1.blob.vercel-storage.com/members/m-1.webp" }),
    ]);

    expect(screen.queryByTestId("photo-failure-banner")).toBeNull();

    fireEvent.error(screen.getByTestId("photo-m-1"));

    // The card stays printable — the monogram replaces the broken image.
    expect(screen.getByTestId("monogram-m-1").textContent).toBe("AC");
    // …but the failure is reported, because "did not load" is not "not uploaded".
    const banner = screen.getByTestId("photo-failure-banner");
    expect(banner.textContent).toContain("1 of 1 photos could not be loaded");
    expect(banner.textContent).toContain("check before printing");
  });

  it("counts each failure separately across members", async () => {
    await renderSheet([
      member({ id: "m-1", name: "Ana Costa", cardToken: "t1", photoUrl: "https://store1.blob.vercel-storage.com/a.webp" }),
      member({ id: "m-2", name: "Bo Lin", cardToken: "t2", photoUrl: "https://store1.blob.vercel-storage.com/b.webp" }),
      member({ id: "m-3", name: "Cy Reed", cardToken: "t3", photoUrl: "https://store1.blob.vercel-storage.com/c.webp" }),
    ]);

    fireEvent.error(screen.getByTestId("photo-m-1"));
    expect(screen.getByTestId("photo-failure-banner").textContent).toContain("1 of 3 photos");

    fireEvent.error(screen.getByTestId("photo-m-3"));
    expect(screen.getByTestId("photo-failure-banner").textContent).toContain("2 of 3 photos");
  });
});

describe("grade", () => {
  it("prints an explicit ungraded state, distinct from a white belt", async () => {
    await renderSheet([member({ rank: null })]);

    const card = screen.getByTestId("card-m-1");
    const belt = card.querySelector("[data-belt-state]") as HTMLElement;
    expect(belt.getAttribute("data-belt-state")).toBe("ungraded");
    expect(belt.textContent).toContain("Ungraded");
    expect(belt.getAttribute("aria-label")).toContain("no belt awarded");
  });

  it("a white belt is NOT the ungraded state", async () => {
    await renderSheet([
      member({ rank: { name: "White Belt", color: "white", stripes: 0, maxStripes: 4 } }),
    ]);

    const card = screen.getByTestId("card-m-1");
    const belt = card.querySelector("[data-belt-state]") as HTMLElement;
    expect(belt.getAttribute("data-belt-state")).toBe("graded");
    expect(belt.textContent).toContain("White Belt");
    expect(belt.textContent).not.toContain("Ungraded");
  });

  it("flags ungraded members in the print preview before printing", async () => {
    await renderSheet([
      member({ id: "m-1", name: "Ana Costa", cardToken: "t1", rank: null }),
      member({ id: "m-2", name: "Bo Lin", cardToken: "t2" }),
    ]);

    const banner = screen.getByTestId("ungraded-banner");
    expect(banner.textContent).toContain("1 of 2");
    expect(banner.textContent).toContain("Ana Costa");
    expect(banner.textContent).not.toContain("Bo Lin");
  });

  it("shows no ungraded banner when everyone has a grade", async () => {
    await renderSheet([member()]);
    expect(screen.queryByTestId("ungraded-banner")).toBeNull();
  });
});

describe("club logo", () => {
  it("renders the club name as text when logoUrl is null, never an empty img", async () => {
    await renderSheet([member()], { name: "Total BJJ", logoUrl: null });

    expect(screen.getByTestId("club-name-m-1").textContent).toBe("Total BJJ");
    expect(screen.queryByTestId("logo-m-1")).toBeNull();
    const emptySrcImages = Array.from(document.querySelectorAll("img")).filter(
      (img) => !img.getAttribute("src"),
    );
    expect(emptySrcImages).toHaveLength(0);
  });

  it("renders the logo through the image proxy when one exists", async () => {
    await renderSheet([member()]);
    const logo = screen.getByTestId("logo-m-1") as HTMLImageElement;
    expect(logo.getAttribute("src")).toContain("/api/blob-image?url=");
    expect(screen.queryByTestId("club-name-m-1")).toBeNull();
  });

  it("falls back to the club name on EVERY card and says so when the logo does not load", async () => {
    await renderSheet([
      member({ id: "m-1", name: "Ana Costa", cardToken: "t1" }),
      member({ id: "m-2", name: "Bo Lin", cardToken: "t2" }),
    ]);

    expect(screen.queryByTestId("logo-failure-banner")).toBeNull();

    fireEvent.error(screen.getByTestId("logo-m-1"));

    // One logo serves the whole sheet, so a 401 from /api/blob-image is not a
    // per-card problem — it is 300 broken-image glyphs on a laminate.
    expect(screen.getByTestId("club-name-m-1").textContent).toBe("Total BJJ");
    expect(screen.getByTestId("club-name-m-2").textContent).toBe("Total BJJ");
    expect(screen.queryByTestId("logo-m-1")).toBeNull();
    expect(screen.getByTestId("logo-failure-banner").textContent).toContain(
      "could not be loaded",
    );
    const emptySrcImages = Array.from(document.querySelectorAll("img")).filter(
      (img) => !img.getAttribute("src"),
    );
    expect(emptySrcImages).toHaveLength(0);
  });
});

describe("the card cap", () => {
  it("says nothing when the whole club fits on the sheet", async () => {
    await renderSheet([member()]);
    expect(screen.queryByTestId("truncation-banner")).toBeNull();
  });

  it("says how many members have NO card when the cap bites", async () => {
    render(
      <MemberCardSheet
        club={CLUB}
        members={[member()]}
        truncation={{ shown: 300, total: 412 }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("truncation-banner")).toBeTruthy());

    // "300 cards across 150 A4 sheets" is a true statement about the paper and
    // a false one about the club; 112 people would find out at the door.
    const banner = screen.getByTestId("truncation-banner");
    expect(banner.textContent).toContain("first 300 of 412");
    expect(banner.textContent).toContain("112");
  });
});

describe("QR codes", () => {
  it("encodes the signed card token, not the member id", async () => {
    await renderSheet([member({ cardToken: "signed.card.token" })]);

    expect(toDataURL).toHaveBeenCalledWith("signed.card.token", expect.anything());
    const qr = screen.getByTestId("qr-m-1") as HTMLImageElement;
    expect(qr.getAttribute("src")).toContain("QR(signed.card.token)");
  });

  it("HARD-FAILS one card: excludes it from the sheet and names the member", async () => {
    toDataURL.mockImplementation(async (text: string) => {
      if (text === "t2") throw new Error("qr encode failed");
      return `data:image/png;base64,QR(${text})`;
    });

    await renderSheet([
      member({ id: "m-1", name: "Ana Costa", cardToken: "t1" }),
      member({ id: "m-2", name: "Bo Lin", cardToken: "t2" }),
    ]);

    // A blank square would laminate fine and be discovered days later.
    expect(screen.queryByTestId("card-m-2")).toBeNull();
    expect(screen.getByTestId("card-m-1")).toBeTruthy();

    const banner = screen.getByTestId("qr-excluded-banner");
    expect(banner.textContent).toContain("1 of 2");
    expect(banner.textContent).toContain("Bo Lin");
  });

  it("names every member and disables Print when the QR fails for all of them", async () => {
    toDataURL.mockImplementation(async () => {
      throw new Error("unreachable");
    });

    render(<MemberCardSheet club={CLUB} members={[member()]} />);

    // Every card failed INDIVIDUALLY, so the sheet is empty and Print is
    // disabled — the excluded banner carries the reason. (The library itself
    // loading is a different branch; the test below covers that one.)
    await waitFor(() => expect(screen.getByTestId("qr-excluded-banner")).toBeTruthy());
    const print = screen.getByRole("button", { name: /print/i }) as HTMLButtonElement;
    expect(print.disabled).toBe(true);
  });

  it("shows an error state, not an empty sheet, when the QR library cannot load", async () => {
    moduleLoadFails = true;

    render(<MemberCardSheet club={CLUB} members={[member()]} />);

    // No banner and no toolbar: nothing on this sheet could carry a code, so
    // there is nothing to offer for printing at all. An empty sheet here would
    // be an outage rendered as "this club has no members" (UI-RULES §7).
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("no cards can be printed");
    expect(screen.queryByTestId("card-m-1")).toBeNull();
    expect(screen.queryByRole("button", { name: /^print$/i })).toBeNull();
  });
});

describe("sheet layout", () => {
  it("puts two cards on one A4 sheet and starts a new sheet for the third", async () => {
    await renderSheet([
      member({ id: "m-1", cardToken: "t1" }),
      member({ id: "m-2", cardToken: "t2" }),
      member({ id: "m-3", cardToken: "t3" }),
    ]);

    expect(document.querySelectorAll(".card-sheet-page")).toHaveLength(2);
    expect(document.querySelectorAll(".card-sheet-cut")).toHaveLength(2);
  });
});
