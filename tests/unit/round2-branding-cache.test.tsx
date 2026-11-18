// Round 2 close-out (10 Nov 2026): this browser's `gym-settings` cache never
// overrides the club's saved branding, and nothing unsaved is published to it.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=branding"),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/settings",
}));
// Selection-time downscale returns the file as is (no canvas in jsdom).
vi.mock("@/lib/downscale-image", () => ({ downscaleImage: async (f: File) => f, IMAGE_MAX_EDGE_PX: 1024 }));

import { mergeLocalBranding } from "@/lib/login-branding";
import ThemeProvider from "@/components/layout/ThemeProvider";

const SERVER = {
  name: "Total BJJ", slug: "totalbjj", logoUrl: null, primaryColor: "#3b82f6", secondaryColor: "#2563eb",
  textColor: "#ffffff", bgColor: "#223344", fontFamily: "'Montserrat', sans-serif",
};
const STALE = { slug: "totalbjj", logoUrl: "data:image/png;base64,UNSAVED", primaryColor: "#ff0000", bgColor: "#000000", fontFamily: "'Bebas Neue', sans-serif" };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("login page branding", () => {
  it("uses the club's saved branding over a stale cache, and a saved 'no logo' stays no logo", () => {
    localStorage.setItem("gym-settings", JSON.stringify(STALE));
    const out = mergeLocalBranding(SERVER as never);
    expect(out).toMatchObject({ logoUrl: null, primaryColor: "#3b82f6", bgColor: "#223344", fontFamily: "'Montserrat', sans-serif" });
  });

  it("the cache only fills a field the server did not send, and only for the same club", () => {
    localStorage.setItem("gym-settings", JSON.stringify(STALE));
    const partial: Partial<typeof SERVER> = { ...SERVER };
    delete partial.bgColor;
    delete partial.fontFamily;
    expect(mergeLocalBranding(partial as never)).toMatchObject({ bgColor: "#000000", fontFamily: "'Bebas Neue', sans-serif", primaryColor: "#3b82f6" });
    localStorage.setItem("gym-settings", JSON.stringify({ ...STALE, slug: "another-club" }));
    expect(mergeLocalBranding(partial as never).bgColor).toBeUndefined();
  });
});

describe("staff theme", () => {
  it("the club's saved accent wins over a stale cached one", () => {
    localStorage.setItem("gym-settings", JSON.stringify(STALE));
    render(<ThemeProvider primaryColor="#3b82f6" secondaryColor="#2563eb" textColor="#ffffff"><p>x</p></ThemeProvider>);
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("#3b82f6");
  });
});

describe("Settings → Branding publishes only what the server confirmed", () => {
  let patchAnswer: () => Promise<unknown>;
  let uploads = 0;
  function install() {
    uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      if (url.includes("/api/upload")) { uploads++; return { ok: true, status: 200, json: async () => ({ url: "https://blob.example.test/logo.png" }) }; }
      if (url.includes("/api/settings") && init?.method === "PATCH") return patchAnswer();
      return { ok: true, status: 200, json: async () => ({}) };
    }));
  }
  async function renderOwner() {
    install();
    const mod = await import("@/components/dashboard/SettingsPage");
    render(React.createElement(mod.default, {
      settings: { ...SERVER, id: "t", subscriptionTier: "pro", subscriptionStatus: "active", logoSize: "md" },
      staff: [], statusCounts: {}, primaryColor: "#3b82f6", role: "owner", currentUserId: "u-1",
    } as never));
    return await screen.findByLabelText("Gym Name", {}, { timeout: 20_000 });
  }
  const cache = () => JSON.parse(localStorage.getItem("gym-settings") ?? "null");
  const pickLogo = () => fireEvent.change(screen.getByLabelText("Club Logo"), {
    target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" })] },
  });

  it("choosing a logo shows it in the editor only; the cache is untouched", async () => {
    patchAnswer = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await renderOwner();
    pickLogo();
    await waitFor(() => expect(screen.getAllByRole("img").some((i) => (i.getAttribute("src") ?? "").startsWith("data:"))).toBe(true), { timeout: 10_000 });
    expect(cache()).toBeNull();
  });

  it("a refused save publishes nothing; a successful one caches the confirmed logo URL", async () => {
    await renderOwner();
    pickLogo();
    await waitFor(() => expect(screen.getAllByRole("img").some((i) => (i.getAttribute("src") ?? "").startsWith("data:"))).toBe(true), { timeout: 10_000 });
    patchAnswer = async () => ({ ok: false, status: 500, json: async () => ({ error: "Failed to update settings" }) });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: /Save Branding/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
    expect(cache()).toBeNull();
    patchAnswer = async () => ({ ok: true, status: 200, json: async () => ({}) });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect(cache()?.logoUrl).toBe("https://blob.example.test/logo.png"), { timeout: 10_000 });
    expect(cache()).toMatchObject({ slug: "totalbjj", bgColor: "#223344", fontFamily: "'Montserrat', sans-serif" });
    // The logo was uploaded once: the retry reused the stored URL, not the preview.
    expect(uploads).toBe(1);
  });

  it("no reply publishes nothing", async () => {
    const name = await renderOwner();
    fireEvent.change(name, { target: { value: "Total BJJ 2" } });
    patchAnswer = async () => { throw new TypeError("Failed to fetch"); };
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: /Save Branding/ }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
    expect(cache()).toBeNull();
  });
});
