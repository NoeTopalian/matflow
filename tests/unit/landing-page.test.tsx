// @vitest-environment jsdom
//
// The public landing page: the two doors (owner applies, member goes to their
// gym), the sections, and what the copy may and may not say. jsdom lays nothing
// out; how it looks at desktop and phone width is the browser run's job.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { LandingNav } from "@/components/landing/LandingNav";
import { Hero } from "@/components/landing/Hero";
import { MemberDoor } from "@/components/landing/MemberDoor";
import { FeaturesGrid } from "@/components/landing/FeaturesGrid";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PricingSection } from "@/components/landing/PricingSection";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { LandingFooter } from "@/components/landing/LandingFooter";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function Page() {
  return (
    <main>
      <LandingNav />
      <Hero />
      <FeaturesGrid />
      <HowItWorks />
      <PricingSection />
      <FinalCTA />
      <LandingFooter />
    </main>
  );
}

const hrefs = (name: string | RegExp) =>
  screen.getAllByRole("link", { name }).map((a) => a.getAttribute("href"));

beforeEach(() => push.mockClear());
afterEach(cleanup);

describe("member door", () => {
  const box = () => screen.getByLabelText("Club code") as HTMLInputElement;
  const go = () => fireEvent.click(screen.getByRole("button", { name: "Go to my gym" }));

  it("sends a typed club code to that club's sign-in page", () => {
    render(<MemberDoor />);
    fireEvent.change(box(), { target: { value: "riverbank-grappling" } });
    expect(box().value).toBe("RIVERBANK-GRAPPLING");
    go();
    expect(push).toHaveBeenCalledWith("/login?club=riverbank-grappling");
  });

  it("reduces a pasted club link to its code", () => {
    render(<MemberDoor />);
    fireEvent.change(box(), { target: { value: "https://matflow.studio/login?club=Riverbank-Grappling" } });
    expect(box().value).toBe("RIVERBANK-GRAPPLING");
    go();
    expect(push).toHaveBeenCalledWith("/login?club=riverbank-grappling");
  });

  it("asks for a code when the box is empty, and clears the message on typing", () => {
    render(<MemberDoor />);
    go();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Enter your club code.");
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(box().getAttribute("aria-describedby")).toBe("club-code-error");
    fireEvent.change(box(), { target: { value: "a" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still works as a plain form when scripts do not run", () => {
    const { container } = render(<MemberDoor />);
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/login");
    expect(form.getAttribute("method")).toBe("get");
    expect(box().getAttribute("name")).toBe("club");
  });
});

describe("the two doors", () => {
  it("the top bar offers Find my gym and Apply", () => {
    render(<LandingNav />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Find my gym" }).getAttribute("href")).toBe("/#find-my-gym");
    expect(within(nav).getByRole("link", { name: "Apply" }).getAttribute("href")).toBe("/apply");
  });

  it("the phone menu opens, lists the sections and closes", () => {
    render(<LandingNav />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const menu = document.getElementById("landing-menu") as HTMLElement;
    expect(within(menu).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "What you get",
      "Moving in",
      "Price",
      "Apply for your club",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(document.getElementById("landing-menu")).toBeNull();
  });

  it("every section link in the top bar points at a section that exists", () => {
    const { container } = render(<Page />);
    for (const id of ["features", "how-it-works", "pricing", "find-my-gym"]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
      expect(container.querySelector(`a[href="/#${id}"]`), id).not.toBeNull();
    }
  });

  it("every apply button goes to /apply and the page ends with both doors", () => {
    render(<Page />);
    expect(new Set(hrefs(/^Apply/))).toEqual(new Set(["/apply"]));
    expect(hrefs("Find my gym")).toEqual(["/#find-my-gym", "/#find-my-gym"]);
  });
});

describe("short logo in the top bar", () => {
  const homeLink = (c: HTMLElement) => c.querySelector('a[aria-label="MatFlow.Studio home"]') as HTMLElement;
  const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  /** jsdom lays nothing out, so the large logo is told where it is. */
  function placeHeroLogo(c: HTMLElement, bottom: number) {
    const hero = c.querySelector("#landing-hero-logo") as HTMLElement;
    hero.getBoundingClientRect = () => ({ bottom }) as DOMRect;
  }

  it("is hidden, and out of the keyboard order, while the large logo is on screen", async () => {
    const { container } = render(<Page />);
    placeHeroLogo(container, 400);
    await frame();
    const link = homeLink(container);
    expect(link.getAttribute("aria-hidden")).toBe("true");
    expect(link.getAttribute("tabindex")).toBe("-1");
    expect(link.className).toContain("opacity-0 pointer-events-none");
  });

  it("appears once the large logo has scrolled under the bar, and hides again on the way back", async () => {
    const { container } = render(<Page />);
    placeHeroLogo(container, 400);
    await frame();
    placeHeroLogo(container, 10);
    fireEvent.scroll(window);
    const link = homeLink(container);
    expect(link.getAttribute("aria-hidden")).toBeNull();
    expect(link.getAttribute("tabindex")).toBeNull();
    expect(link.className).toContain("opacity-100");
    placeHeroLogo(container, 400);
    fireEvent.scroll(window);
    expect(homeLink(container).getAttribute("aria-hidden")).toBe("true");
  });

  it("is shown on a page that has no large logo", async () => {
    const { container } = render(<LandingNav />);
    await frame();
    expect(homeLink(container).getAttribute("aria-hidden")).toBeNull();
  });
});

describe("page content", () => {
  it("has one main heading and a heading per section", () => {
    render(<Page />);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Run your academy from the mat.",
    ]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Train here?",
      "What you get",
      "How we move you in",
      "Price",
      "Bring your club over.",
    ]);
  });

  it("lists four things a club gets and three steps to move in", () => {
    render(<Page />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Timetable",
      "Check-in at the door",
      "Belts and stripes",
      "Members and reports",
      "Apply",
      "Send your member list",
      "Open the doors",
    ]);
  });

  it("shows the product: one real screen per feature, said to be an example club", () => {
    const { container } = render(<Page />);
    const features = container.querySelector("#features") as HTMLElement;
    expect(features.textContent).toContain("These are the real screens, shown with an example club.");
    // The wide timetable scrolls inside its own frame on a phone, and the frame is keyboard reachable.
    const frame = within(features).getByRole("region", { name: "Timetable picture, scrolls sideways" });
    expect(frame.getAttribute("tabindex")).toBe("0");
    const pictures = within(features).getAllByRole("img");
    expect(pictures.map((img) => (img.getAttribute("alt") ?? "").split(".")[0])).toEqual([
      "A club's week in MatFlow",
      "The check-in screen on a tablet, under the club's name",
      "A member's Progress screen on their phone",
      "The Members screen",
    ]);
    // Every picture is described and sits in a figure with a caption.
    for (const img of pictures) {
      expect((img.getAttribute("alt") ?? "").length).toBeGreaterThan(60);
      expect(img.closest("figure")?.querySelector("figcaption")?.textContent).toBeTruthy();
    }
  });

  it("does not claim what the product does not do, and reads as plain English", () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";
    // Card payments by members are not switched on; emails to members are off.
    expect(text).not.toMatch(/Stripe|pay online|card payment|invite/);
    // Engineer vocabulary and the old single-sport framing.
    expect(text).not.toMatch(/HMAC|RLS|row-level|idempotent|webhook|PWA|tenant|BJJ/i);
    // No dashes used as punctuation.
    expect(text).not.toMatch(/[–—]/);
    expect(text).toContain("martial arts academies");
    expect(text).toContain("© 2026 MatFlow.Studio");
  });
});
