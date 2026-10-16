// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import React from "react";

/**
 * Owner onboarding, batch 1 (16 Oct 2026).
 *
 *   1. Only fields the owner changed are sent: a reopened wizard never moves
 *      the club's time zone or resets its logo size.
 *   2. Every save is checked: a non-2xx or network failure keeps the owner on
 *      the step with a message; a failed completion never shows "ready".
 *   3. Back then Continue on the timetable step creates no duplicate class.
 *   4. A logo is uploaded once per chosen file; a failed upload stays put.
 *   5. Setup-banner links open the page that does the job, not the wizard.
 *   6. One progress label, one Skip; a double click moves one step.
 */

const toastMock = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement("img", { alt: String(props.alt ?? ""), src: String(props.src ?? "") }),
}));
vi.mock("@/lib/downscale-image", () => ({
  IMAGE_MAX_EDGE_PX: 1024,
  downscaleImage: async (f: File) => f,
}));

import OwnerOnboardingWizard from "@/components/onboarding/OwnerOnboardingWizard";
import { getSetupGaps } from "@/lib/setup-gaps";

const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const OTHER_ZONE = DEVICE_ZONE === "Pacific/Chatham" ? "Pacific/Apia" : "Pacific/Chatham";
const TENANT = "Total BJJ";
const STEP_KEY = `matflow.onboarding.step.${TENANT}`;

type Call = { url: string; method: string; body: unknown; raw?: unknown };

function stubFetch(respond: (url: string, method: string) => Response | Promise<Response> | "throw") {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ url, method, body, raw: init?.body });
    const r = await respond(url, method);
    if (r === "throw") throw new TypeError("Failed to fetch");
    // The wizard reads the club's class list (/api/classes?strict=1) before
    // saving classes; a catch-all stub's non-list answer means "no classes".
    if (url.startsWith("/api/classes?") && r.ok) {
      const body = await r.clone().json().catch(() => null);
      if (!Array.isArray(body)) return ok([]);
    }
    return r;
  });
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return calls;
}

const ok = (json: unknown = {}) => new Response(JSON.stringify(json), { status: 200 });
const fail = (status: number, error = "nope") => new Response(JSON.stringify({ error }), { status });

function openAt(step: number) {
  sessionStorage.setItem(STEP_KEY, String(step));
}
const currentStep = () => sessionStorage.getItem(STEP_KEY);

function renderWizard(props: Partial<React.ComponentProps<typeof OwnerOnboardingWizard>> = {}) {
  return render(
    <OwnerOnboardingWizard tenantName={TENANT} ownerName="Sean Coates" primaryColor="#3b82f6" {...props} />,
  );
}

const patches = (calls: Call[]) => calls.filter((c) => c.url === "/api/settings" && c.method === "PATCH");

// The wizard ignores a click that lands within 400 ms of a step change (the
// second half of a double click). `later()` moves the clock past that window
// to model a deliberate next click.
let clockOffset = 0;
const realNow = Date.now.bind(Date);
function later() { clockOffset += 1000; }

beforeEach(() => {
  sessionStorage.clear();
  toastMock.mockReset();
  clockOffset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("step 1 sends only what changed", () => {
  it("unchanged name and a reopened club: no request, moves on", async () => {
    const calls = stubFetch(() => ok());
    renderWizard({ storedName: TENANT, storedTimezone: OTHER_ZONE, alreadyOnboarded: true });
    // The note tells the truth about the zone instead of promising a change.
    expect(await screen.findByText(/time zone stays/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what do you teach/i);
    expect(patches(calls)).toHaveLength(0);
  });

  it("reopened club with a new name: sends the name, never the device zone", async () => {
    const calls = stubFetch(() => ok());
    renderWizard({ storedName: TENANT, storedTimezone: OTHER_ZONE, alreadyOnboarded: true });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "Total BJJ Bristol" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what do you teach/i);
    expect(patches(calls).map((c) => c.body)).toEqual([{ name: "Total BJJ Bristol" }]);
  });

  it("compares with the club's saved name, not the session's stale copy", async () => {
    const calls = stubFetch(() => ok());
    // Renamed to "Total BJJ Bristol" in Settings; the session still says "Total BJJ".
    renderWizard({ storedName: "Total BJJ Bristol", storedTimezone: OTHER_ZONE, alreadyOnboarded: true });
    expect((screen.getByLabelText("Gym Name") as HTMLInputElement).value).toBe("Total BJJ Bristol");
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "Total BJJ" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what do you teach/i);
    expect(patches(calls).map((c) => c.body)).toEqual([{ name: "Total BJJ" }]);
  });

  it("club in first setup whose zone differs: sends the device zone, says so on screen", async () => {
    const calls = stubFetch(() => ok());
    renderWizard({ storedTimezone: OTHER_ZONE, alreadyOnboarded: false });
    expect(await screen.findByText(/from this device/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what do you teach/i);
    expect(patches(calls).map((c) => c.body)).toEqual([{ timezone: DEVICE_ZONE }]);
  });

  it("club in first setup with no stored zone: sends the device zone", async () => {
    const calls = stubFetch(() => ok());
    renderWizard({ storedTimezone: null, alreadyOnboarded: false });
    await screen.findByText(/from this device/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what do you teach/i);
    expect(patches(calls).map((c) => c.body)).toEqual([{ timezone: DEVICE_ZONE }]);
  });

  it("club in first setup already on the device zone: nothing to send", async () => {
    const calls = stubFetch(() => ok());
    renderWizard({ storedTimezone: DEVICE_ZONE, alreadyOnboarded: false });
    await screen.findByText(/time zone stays/i);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText(/what do you teach/i);
    expect(patches(calls)).toHaveLength(0);
  });
});

describe("every save is checked", () => {
  it("a 400 keeps the owner on step 1 and names what the server refused", async () => {
    stubFetch(() => fail(400, "Invalid data"));
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't save that: Invalid data\. Check what you entered/i), "error", expect.any(Number)));
    expect((screen.getByLabelText("Gym Name") as HTMLInputElement).value).toBe("New name");
    expect(screen.queryByText(/what do you teach/i)).toBeNull();
  });

  it("a network failure keeps the owner on step 1 with the failure message", async () => {
    stubFetch(() => "throw");
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error", expect.any(Number)));
    expect(screen.queryByText(/what do you teach/i)).toBeNull();
  });

  it("a failed questionnaire save keeps the owner on step 6", async () => {
    const calls = stubFetch(() => fail(500));
    openAt(6);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "21–50" }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error", expect.any(Number)));
    expect(patches(calls)).toHaveLength(1);
    expect(screen.getByText(/tell us about your gym/i)).toBeTruthy();
    expect(currentStep()).toBe("6");
  });

  it("a failed completion save never shows the ready screen (Finish)", async () => {
    const calls = stubFetch(() => fail(500));
    openAt(9);
    renderWizard();
    fireEvent.click(await screen.findByText(/add members manually later/i));
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't finish setup/i), "error", expect.any(Number)));
    expect(patches(calls).map((c) => c.body)).toEqual([{ onboardingCompleted: true }]);
    expect(screen.getByText(/bring your members across/i)).toBeTruthy();
  });

  it("a failed completion save never shows the ready screen (Skip)", async () => {
    stubFetch(() => "throw");
    openAt(9);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't finish setup/i), "error", expect.any(Number)));
    expect(screen.getByText(/bring your members across/i)).toBeTruthy();
  });

  it("a successful completion shows the ready screen", async () => {
    stubFetch(() => ok());
    openAt(9);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    await screen.findByText(/your gym is ready/i);
    expect(toastMock).not.toHaveBeenCalled();
  });
});

describe("step 3: ranks", () => {
  async function saveJudoThenGoBack(calls: Call[]) {
    openAt(3);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /judo belt system/i }));
    fireEvent.click(screen.getByRole("button", { name: /add 1 system/i }));
    await screen.findByText(/add your classes/i);
    expect(calls.filter((c) => c.url === "/api/ranks").length).toBeGreaterThan(0);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/set up your ranks/i);
    // Deselect the saved system.
    fireEvent.click(screen.getByRole("button", { name: /judo belt system/i }));
    later();
  }

  it("removing a saved belt system then Continue says it stays saved", async () => {
    const calls = stubFetch(() => ok({ id: "r" }));
    await saveJudoThenGoBack(calls);
    const before = calls.filter((c) => c.url === "/api/ranks").length;
    fireEvent.click(screen.getByRole("button", { name: /^continue/i }));
    await screen.findByText(/add your classes/i);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/belt systems and ranks you'd already saved stay as first saved/i), "info", 6000);
    expect(calls.filter((c) => c.url === "/api/ranks")).toHaveLength(before);
  });

  it("removing a saved belt system then Skip says it stays saved", async () => {
    const calls = stubFetch(() => ok({ id: "r" }));
    await saveJudoThenGoBack(calls);
    fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
    await screen.findByText(/add your classes/i);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/belt systems and ranks you'd already saved/i), "info", 6000);
  });

  it("no notice when nothing saved was removed", async () => {
    stubFetch(() => ok({ id: "r" }));
    openAt(3);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /judo belt system/i }));
    fireEvent.click(screen.getByRole("button", { name: /add 1 system/i }));
    await screen.findByText(/add your classes/i);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("a failed rank save keeps the step; the retry re-sends safely (409 counts as saved)", async () => {
    let rankPosts = 0;
    const calls = stubFetch((url) => {
      if (url !== "/api/ranks") return ok();
      rankPosts++;
      if (rankPosts === 2) return fail(503);
      return rankPosts > 2 && rankPosts <= 3 ? fail(409) : ok({ id: `r${rankPosts}` });
    });
    openAt(3);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /judo belt system/i }));
    fireEvent.click(screen.getByRole("button", { name: /add 1 system/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/some ranks didn't save/i), "error", expect.any(Number)));
    expect(screen.getByText(/set up your ranks/i)).toBeTruthy();
    const firstPass = calls.filter((c) => c.url === "/api/ranks").length;
    fireEvent.click(screen.getByRole("button", { name: /add 1 system/i }));
    await screen.findByText(/add your classes/i);
    expect(calls.filter((c) => c.url === "/api/ranks")).toHaveLength(firstPass * 2);
  });
});

describe("step 4: classes", () => {
  function addMondayClass(name: string) {
    fireEvent.click(screen.getByRole("button", { name: /add a class/i }));
    const inputs = screen.getAllByLabelText("Class name");
    fireEvent.change(inputs[inputs.length - 1], { target: { value: name } });
    const mondays = screen.getAllByRole("button", { name: "Mon" });
    fireEvent.click(mondays[mondays.length - 1]);
  }

  it("Back then Continue creates each class once", async () => {
    const calls = stubFetch(() => ok({ id: "c1" }));
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Fundamentals");
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await screen.findByText(/make it yours/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/add your classes/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await waitFor(() => expect(screen.queryByText(/add your classes/i)).toBeNull());
    expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/instances/generate")).toHaveLength(1);
  });

  it("a saved class removed after Back is reported, not silently kept", async () => {
    stubFetch(() => ok({ id: "c1" }));
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Fundamentals");
    addMondayClass("No-Gi");
    fireEvent.click(screen.getByRole("button", { name: /save 2 classes/i }));
    await screen.findByText(/make it yours/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/add your classes/i);
    fireEvent.click(screen.getAllByRole("button", { name: /remove class/i })[1]);
    later();
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/including any you removed/i), "info", 6000));
  });

  it("a network failure keeps the step; the retry creates only the missing one", async () => {
    let classPosts = 0;
    const calls = stubFetch((url, method) => {
      if (url === "/api/classes" && method === "POST") return ++classPosts === 2 ? fail(503) : ok({ id: `c${classPosts}` });
      if (url.startsWith("/api/classes?")) return ok([]); // the class list: the 503 created nothing
      return ok();
    });
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Fundamentals");
    addMondayClass("No-Gi");
    fireEvent.click(screen.getByRole("button", { name: /save 2 classes/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/some classes didn't save/i), "error", expect.any(Number)));
    expect(screen.getByText(/add your classes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /save 2 classes/i }));
    await waitFor(() => expect(screen.queryByText(/add your classes/i)).toBeNull());
    const names = calls.filter((c) => c.url === "/api/classes" && c.method === "POST").map((c) => (c.body as { name: string }).name);
    expect(names).toEqual(["Fundamentals", "No-Gi", "No-Gi"]);
  });

  it("a class the server refuses is named with its reason, not promised a retry", async () => {
    stubFetch((url) => (url === "/api/classes" ? fail(400, "Capacity must be at least 1") : ok()));
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Open Mat");
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const [msg] = toastMock.mock.calls[0] as [string];
    expect(msg).toMatch(/Open Mat/);
    expect(msg).toMatch(/Capacity must be at least 1/);
    expect(msg).not.toMatch(/try again/i);
    expect(screen.getByText(/add your classes/i)).toBeTruthy();
  });

  it("a signed-out 401 is not blamed on the class", async () => {
    stubFetch((url) => (url === "/api/classes" ? fail(401, "Unauthorized") : ok()));
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Open Mat");
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/sign in again/i), "error", expect.any(Number)));
    expect(toastMock.mock.calls[0][0]).not.toMatch(/weren't accepted/);
  });

  it("a saved class edited down to a blank draft is reported", async () => {
    stubFetch(() => ok({ id: "c1" }));
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Fundamentals");
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await screen.findByText(/make it yours/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/add your classes/i);
    fireEvent.change(screen.getByLabelText("Class name"), { target: { value: "" } });
    later();
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/stay as first saved/i), "info", 6000));
  });
});

describe("step 5: branding", () => {
  async function chooseLogo() {
    const file = new File(["png"], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose a logo image to upload"), { target: { files: [file] } });
    await screen.findByText(/logo size in member app/i);
  }

  it("no theme, no logo, logo size unchanged: no settings request", async () => {
    const calls = stubFetch(() => ok());
    openAt(5);
    renderWizard({ storedLogoSize: "lg" });
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("6"));
    expect(patches(calls)).toHaveLength(0);
  });

  it("a new logo uploads once and a changed size is sent; passing again sends nothing", async () => {
    const calls = stubFetch((url) => (url === "/api/upload" ? ok({ url: "https://blob.test/logo.png" }) : ok()));
    openAt(5);
    renderWizard({ storedLogoSize: "md" });
    await screen.findByText(/make it yours/i);
    await chooseLogo();
    fireEvent.click(screen.getByRole("button", { name: "Large" }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("6"));
    expect(patches(calls).map((c) => c.body)).toEqual([{ logoSize: "lg", logoUrl: "https://blob.test/logo.png" }]);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/make it yours/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("6"));
    expect(calls.filter((c) => c.url === "/api/upload")).toHaveLength(1);
    expect(patches(calls)).toHaveLength(1);
  });

  it("a failed save after a good upload stays; the retry reuses the upload", async () => {
    let settingsPatches = 0;
    const calls = stubFetch((url) => {
      if (url === "/api/upload") return ok({ url: "https://blob.test/logo.png" });
      if (url === "/api/settings") return ++settingsPatches === 1 ? fail(500) : ok();
      return ok();
    });
    openAt(5);
    renderWizard();
    await screen.findByText(/make it yours/i);
    await chooseLogo();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error", expect.any(Number)));
    expect(currentStep()).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("6"));
    expect(calls.filter((c) => c.url === "/api/upload")).toHaveLength(1);
    expect(patches(calls).map((c) => c.body)).toEqual([
      { logoUrl: "https://blob.test/logo.png" },
      { logoUrl: "https://blob.test/logo.png" },
    ]);
  });

  it("a failed upload stays on the step and saves nothing", async () => {
    const calls = stubFetch((url) => (url === "/api/upload" ? fail(413, "File too large") : ok()));
    openAt(5);
    renderWizard();
    await screen.findByText(/make it yours/i);
    await chooseLogo();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/didn't upload: File too large.*Your current logo hasn't changed/), "error", 8000));
    expect(patches(calls)).toHaveLength(0);
    expect(currentStep()).toBe("5");
  });
});

describe("one request per click", () => {
  it("two clicks before React re-renders send one save", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = stubFetch(async () => { await gate; return ok(); });
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    const cont = screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
    act(() => { cont.click(); cont.click(); });
    await act(async () => { release(); await gate; });
    await screen.findByText(/what do you teach/i);
    expect(patches(calls)).toHaveLength(1);
    expect(currentStep()).toBe("2");
  });

  it("the second click of a double click on Continue does not move a second step", async () => {
    stubFetch(() => ok());
    openAt(5);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    await screen.findByText(/tell us about your gym/i);
    // Step 6's buttons now sit where step 5's were.
    fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
    expect(currentStep()).toBe("6");
  });

  it("the second click of a double click on Skip does not move a second step", async () => {
    stubFetch(() => ok());
    openAt(6);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /^skip/i }));
    await screen.findByText(/how will you take payments/i);
    fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
    expect(currentStep()).toBe("7");
    later();
    fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
    await waitFor(() => expect(currentStep()).toBe("8"));
  });

  it("the second click of a double click on Back does not go back two steps", async () => {
    stubFetch(() => ok());
    openAt(6);
    renderWizard();
    await screen.findByText(/tell us about your gym/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/make it yours/i);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(currentStep()).toBe("5");
  });

  it("Back and Skip are disabled while a save is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubFetch(async () => { await gate; return ok(); });
    openAt(6);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "21–50" }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^skip/i }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); await gate; });
  });

  it("one Skip and one progress label on a step that used to show two", async () => {
    stubFetch(() => ok());
    openAt(6);
    renderWizard();
    await screen.findByText(/tell us about your gym/i);
    expect(screen.getAllByRole("button", { name: /^skip/i })).toHaveLength(1);
    expect(screen.getAllByText(/step 6 of 9/i)).toHaveLength(1);
  });
});

describe("step 9: CSV hand-off", () => {
  async function chooseCsv(name = "members.csv") {
    openAt(9);
    renderWizard();
    fireEvent.click(await screen.findByText(/send my csv to matflow/i));
    const file = new File(["name,email\nA,a@x.test"], name, { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose a CSV file of your members"), { target: { files: [file] } });
  }
  const refOf = (c: Call) => (c.raw as FormData).get("clientRef");
  const handoffs = (calls: Call[]) => calls.filter((c) => c.url === "/api/onboarding/csv-handoff");

  it("a lost response is reported, Finish stays locked, and the retry carries the same reference", async () => {
    let n = 0;
    const calls = stubFetch((url) => {
      if (url !== "/api/onboarding/csv-handoff") return ok();
      return ++n === 1 ? "throw" : new Response(JSON.stringify({ jobId: "j1", message: "We already have this file — it was received the first time, so nothing was sent twice.", alreadyReceived: true }), { status: 200 });
    });
    await chooseCsv();
    fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't confirm your file arrived/i);
    expect((screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement).disabled).toBe(true);
    const retry = screen.getByRole("button", { name: /^upload csv/i }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await screen.findByText(/nothing was sent twice/i);
    const sent = handoffs(calls);
    expect(sent).toHaveLength(2);
    expect(refOf(sent[0])).toMatch(/^[a-f0-9]{32}$/);
    expect(refOf(sent[1])).toBe(refOf(sent[0]));
    expect((screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refused file says why and nothing claims it was uploaded", async () => {
    stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? fail(400, "Only CSV files are supported") : ok()));
    await chooseCsv();
    fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wasn't sent: Only CSV files are supported/);
    expect(screen.queryByText(/^uploaded$/i)).toBeNull();
  });

  it("a signed-out 401 asks the owner to sign in again", async () => {
    stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? fail(401, "Unauthorized") : ok()));
    await chooseCsv();
    fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/signed out/i);
  });

  it("choosing a different file starts a new hand-off with a new reference", async () => {
    let n = 0;
    const calls = stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? (++n === 1 ? fail(503) : ok({ jobId: "j2", message: "ok" })) : ok()));
    await chooseCsv("first.csv");
    fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
    await screen.findByRole("alert");
    const second = new File(["name\nB"], "second.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose a CSV file of your members"), { target: { files: [second] } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
    await waitFor(() => expect(handoffs(calls)).toHaveLength(2));
    const [a, b] = handoffs(calls);
    expect(refOf(b)).not.toBe(refOf(a));
  });
});

describe("final review fixes (16 Oct 2026, evening)", () => {
  it("step 1: a signed-out 401 asks the owner to sign in, not to check the connection", async () => {
    stubFetch(() => fail(401, "Unauthorized"));
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/signed out/i), "error", 8000));
  });

  it("step 6: a reopened wizard shows the saved answers and passing it unchanged sends nothing", async () => {
    const calls = stubFetch(() => ok());
    openAt(6);
    renderWizard({ alreadyOnboarded: true, storedAnswers: { size: "21–50", goals: ["Grow membership"], referral: "friend", referralOther: null } });
    await screen.findByText(/tell us about your gym/i);
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("7"));
    expect(patches(calls)).toHaveLength(0);
  });

  it("step 6: changing an answer sends the full answer set once", async () => {
    const calls = stubFetch(() => ok());
    openAt(6);
    renderWizard({ alreadyOnboarded: true, storedAnswers: { size: "21–50", goals: [], referral: "", referralOther: null } });
    await screen.findByText(/tell us about your gym/i);
    fireEvent.click(screen.getByRole("button", { name: "51–100" }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("7"));
    expect(patches(calls).map((c) => (c.body as { onboardingAnswers: { size: string } }).onboardingAnswers.size)).toEqual(["51–100"]);
  });

  it("step 1: a 403 shows the server's reason, not 'signed out'", async () => {
    stubFetch(() => fail(403, "Support access is read-only."));
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("That wasn't saved: Support access is read-only.", "error", 8000));
  });

  it("step 1: the club name input is capped at the API's 100 characters", () => {
    stubFetch(() => ok());
    renderWizard();
    expect((screen.getByLabelText("Gym Name") as HTMLInputElement).maxLength).toBe(100);
  });

  it("step 6: when the saved answers could not be read, nothing is sent and the owner is told", async () => {
    const calls = stubFetch(() => ok());
    openAt(6);
    renderWizard({ alreadyOnboarded: true, storedAnswers: null, answersUnknown: true });
    fireEvent.click(await screen.findByRole("button", { name: "21–50" }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(currentStep()).toBe("7"));
    expect(patches(calls)).toHaveLength(0);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/earlier answers couldn't be loaded/i), "info", 8000);
  });

  describe("step 4: a class whose save got no answer", () => {
    const fundamentals = { id: "srv-1", name: "Fundamentals", schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] };
    function addMonday(name: string) {
      fireEvent.click(screen.getByRole("button", { name: /add a class/i }));
      fireEvent.change(screen.getAllByLabelText("Class name").at(-1)!, { target: { value: name } });
      fireEvent.click(screen.getAllByRole("button", { name: "Mon" }).at(-1)!);
    }

    it("is found and adopted on the retry — no second class", async () => {
      let created = false;
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ok(created ? [fundamentals] : []);
        if (url === "/api/classes" && method === "POST") { created = true; return "throw"; } // made, answer lost
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/classes already saved won't be added twice/), "error", 10000));
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await screen.findByText(/make it yours/i);
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
    });

    it("a same-named class the club already had is not adopted", async () => {
      let posts = 0;
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ok([fundamentals]); // existed before this run
        if (url === "/api/classes" && method === "POST") return ++posts === 1 ? "throw" : ok({ id: "srv-2" });
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await screen.findByText(/make it yours/i);
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(2);
    });

    it("a save that got no answer is not re-sent while the class list can't be read (L-01)", async () => {
      let listCalls = 0;
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ++listCalls === 1 ? ok([]) : fail(503); // snapshot ok, retry-time read fails
        if (url === "/api/classes" && method === "POST") return "throw";
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      toastMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't check whether “Fundamentals” reached us. Press Save again/), "error", 10000));
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
      expect(screen.getByText(/add your classes/i)).toBeTruthy();
    });

    it("an unanswered save that the owner then edits is adopted by what was sent, and the edit is reported (L-02)", async () => {
      let created = false;
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ok(created ? [fundamentals] : []);
        if (url === "/api/classes" && method === "POST") { created = true; return "throw"; }
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      // The owner assumes it failed and changes the end time.
      fireEvent.change(screen.getByLabelText("End time"), { target: { value: "19:30" } });
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await screen.findByText(/make it yours/i);
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/classes you'd already saved stay as first saved/i), "info", 6000);
    });

    it("Skip past a save that couldn't be checked names the class and what to do", async () => {
      let listCalls = 0;
      stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ++listCalls === 1 ? ok([]) : fail(503);
        if (url === "/api/classes" && method === "POST") return "throw";
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      later();
      fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
      await screen.findByText(/make it yours/i);
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't check whether “Fundamentals” reached us.*Timetable page: add it if missing, or delete the extra/), "info", 10000);
    });

    it("a lost save the server made, whose draft the owner then removes, is adopted and reported — nothing re-sent (C-03a)", async () => {
      let created = false;
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ok(created ? [fundamentals] : []);
        if (url === "/api/classes" && method === "POST") { created = true; return "throw"; }
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: /remove class/i }));
      fireEvent.click(screen.getByRole("button", { name: /^continue/i }));
      await screen.findByText(/make it yours/i);
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/classes you'd already saved stay as first saved, including any you removed/i), "info", 6000);
    });

    it("the same, with the list unreadable at retry: advances and names the class to check (C-03b)", async () => {
      let listCalls = 0;
      stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ++listCalls === 1 ? ok([]) : fail(503);
        if (url === "/api/classes" && method === "POST") return "throw";
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: /remove class/i }));
      fireEvent.click(screen.getByRole("button", { name: /^continue/i }));
      await screen.findByText(/make it yours/i);
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't check whether “Fundamentals” reached us/), "info", 10000);
    });

    it("Skip after a lost save that never reached the server, draft removed: says it wasn't saved (C-02)", async () => {
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return ok([]);
        if (url === "/api/classes" && method === "POST") return "throw";
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: /remove class/i }));
      later();
      fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
      await screen.findByText(/make it yours/i);
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/“Fundamentals” wasn't saved\. Add it on the Timetable page/), "info", 10000);
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
    });

    it("offline at Save (class list unreadable before any save): nothing is sent, and the next Save works (C-01)", async () => {
      let online = false;
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return online ? ok([]) : "throw";
        if (url === "/api/classes" && method === "POST") return online ? ok({ id: "srv-9" }) : "throw";
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't reach MatFlow, so no classes were saved/), "error", 8000));
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(0);
      online = true;
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await screen.findByText(/make it yours/i);
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(1);
    });

    it("when the class list can't be read before saving, nothing is sent and the owner is told", async () => {
      const calls = stubFetch((url, method) => {
        if (url.startsWith("/api/classes?") && method === "GET") return fail(500);
        if (url === "/api/classes" && method === "POST") return "throw";
        return ok();
      });
      openAt(4);
      renderWizard();
      await screen.findByText(/add your classes/i);
      addMonday("Fundamentals");
      fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
      await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't reach MatFlow, so no classes were saved/), "error", 8000));
      expect(calls.filter((c) => c.url === "/api/classes" && c.method === "POST")).toHaveLength(0);
    });
  });

  it("step 4: Skip after removing a saved class says it stays saved", async () => {
    stubFetch(() => ok({ id: "c1" }));
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    fireEvent.click(screen.getByRole("button", { name: /add a class/i }));
    fireEvent.change(screen.getByLabelText("Class name"), { target: { value: "Fundamentals" } });
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    fireEvent.click(screen.getByRole("button", { name: /save 1 class/i }));
    await screen.findByText(/make it yours/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/add your classes/i);
    fireEvent.click(screen.getByRole("button", { name: /remove class/i }));
    later();
    fireEvent.click(screen.getByRole("button", { name: /^skip/i }));
    await screen.findByText(/make it yours/i);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/classes you'd already saved stay as first saved/i), "info", 6000);
  });

  async function saveCustomSystem() {
    openAt(3);
    renderWizard();
    await screen.findByText(/set up your ranks/i);
    fireEvent.click(screen.getByRole("button", { name: /build a custom rank system/i }));
    fireEvent.change(screen.getByLabelText("Discipline name"), { target: { value: "Judo Club" } });
    fireEvent.change(screen.getByLabelText("Name for rank 1"), { target: { value: "White" } });
    fireEvent.click(screen.getByRole("button", { name: /^continue/i }));
    await screen.findByText(/add your classes/i);
    later();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText(/set up your ranks/i);
  }

  it("step 3: removing a saved custom belt system is reported", async () => {
    stubFetch(() => ok({ id: "r" }));
    await saveCustomSystem();
    fireEvent.click(screen.getByRole("button", { name: /remove custom system/i }));
    later();
    fireEvent.click(screen.getByRole("button", { name: /^continue/i }));
    await screen.findByText(/add your classes/i);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/belt systems and ranks you'd already saved/i), "info", 6000);
  });

  it("step 3: renaming a saved custom rank is reported (the server keeps the first name: 409)", async () => {
    let n = 0;
    stubFetch((url) => (url === "/api/ranks" ? (++n === 1 ? ok({ id: "r" }) : fail(409)) : ok()));
    await saveCustomSystem();
    fireEvent.change(screen.getByLabelText("Name for rank 1"), { target: { value: "White Belt" } });
    later();
    fireEvent.click(screen.getByRole("button", { name: /^continue/i }));
    await screen.findByText(/add your classes/i);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/belt systems and ranks you'd already saved/i), "info", 6000);
  });

  it("step 3: a retry answered 409 for ranks saved by the first pass advances with no notice", async () => {
    // Pass 1: the third rank fails. Pass 2 (retry): the server already has
    // every other rank (409); only the third is new.
    let pass = 1, i = 0;
    const calls = stubFetch((url) => {
      if (url !== "/api/ranks") return ok();
      i++;
      if (pass === 1) return i === 3 ? fail(503) : ok({ id: `r${i}` });
      return i === 3 ? ok({ id: "r3" }) : fail(409);
    });
    openAt(3);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /judo belt system/i }));
    fireEvent.click(screen.getByRole("button", { name: /add 1 system/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/some ranks didn't save/i), "error", 8000));
    toastMock.mockClear();
    const firstPass = calls.filter((c) => c.url === "/api/ranks").length;
    pass = 2; i = 0;
    fireEvent.click(screen.getByRole("button", { name: /add 1 system/i }));
    await screen.findByText(/add your classes/i);
    expect(firstPass).toBeGreaterThan(3);
    expect(calls.filter((c) => c.url === "/api/ranks")).toHaveLength(firstPass * 2);
    expect(toastMock).not.toHaveBeenCalled();
  });

  describe("CSV hand-off reference across a reload", () => {
    const file = () => new File(["name,email\nA,a@x.test"], "members.csv", { type: "text/csv", lastModified: 1_700_000_000_000 });
    async function pickAndUpload() {
      fireEvent.click(await screen.findByText(/send my csv to matflow/i));
      fireEvent.change(screen.getByLabelText("Choose a CSV file of your members"), { target: { files: [file()] } });
      fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
    }
    const refOf = (c: Call) => (c.raw as FormData).get("clientRef");

    it("the same file after a reload keeps its reference; changed notes are reported on a replay", async () => {
      let n = 0;
      const calls = stubFetch((url) => {
        if (url !== "/api/onboarding/csv-handoff") return ok();
        return ++n === 1 ? "throw" : new Response(JSON.stringify({ jobId: "j1", message: "We already have this file, so it wasn't sent twice.", alreadyReceived: true }), { status: 200 });
      });
      openAt(9);
      renderWizard();
      await pickAndUpload();
      await screen.findByText(/couldn't confirm your file arrived/i);
      cleanup(); // the owner reloads
      openAt(9);
      renderWizard();
      fireEvent.click(await screen.findByText(/send my csv to matflow/i));
      fireEvent.change(screen.getByLabelText("Choose a CSV file of your members"), { target: { files: [file()] } });
      fireEvent.change(screen.getByLabelText("Notes about your CSV file"), { target: { value: "phones in column G" } });
      fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
      await screen.findByText(/notes you changed after your first attempt may not have been added/i);
      const sent = calls.filter((c) => c.url === "/api/onboarding/csv-handoff");
      expect(sent).toHaveLength(2);
      expect(refOf(sent[1])).toBe(refOf(sent[0]));
    });

    it("our 503 (uploads unavailable) says the file wasn't sent and points to another option", async () => {
      stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? new Response(JSON.stringify({ error: "File uploads not configured", code: "uploads_unavailable" }), { status: 503 }) : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      expect((await screen.findByRole("alert")).textContent).toMatch(/wasn't sent: uploads aren't available right now\. Choose another option above/);
    });

    it("the proxy's retryable sign-in 503 (JSON, no code) is unconfirmed, not 'uploads unavailable'", async () => {
      stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? new Response(JSON.stringify({ ok: false, error: "We couldn't confirm your sign-in just now. Please try again in a moment.", retryable: true }), { status: 503 }) : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't confirm your file arrived/i);
    });

    it("a 403 shows the server's own reason, not 'signed out'", async () => {
      stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? fail(403, "Support access is read-only.") : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      const t = (await screen.findByRole("alert")).textContent ?? "";
      expect(t).toMatch(/wasn't sent: Support access is read-only\./);
      expect(t).not.toMatch(/signed out/i);
    });

    it("after a confirmed upload, a reload and the same file reuse the reference (the route answers 'already have it')", async () => {
      const calls = stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? new Response(JSON.stringify({ jobId: "j", message: "ok" }), { status: 201 }) : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      await screen.findByText(/^ok$/);
      cleanup(); // the page reloads before Finish
      openAt(9);
      renderWizard();
      await pickAndUpload();
      await waitFor(() => expect(calls.filter((c) => c.url === "/api/onboarding/csv-handoff")).toHaveLength(2));
      const [a, b] = calls.filter((c) => c.url === "/api/onboarding/csv-handoff");
      expect(refOf(b)).toBe(refOf(a));
    });

    it("finishing setup forgets the CSV reference for this tab (L-04)", async () => {
      stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? new Response(JSON.stringify({ jobId: "j", message: "ok" }), { status: 201 }) : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      await screen.findByText(/^ok$/);
      expect(sessionStorage.getItem(`${STEP_KEY}.csvref`)).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));
      await screen.findByText(/your gym is ready/i);
      expect(sessionStorage.getItem(`${STEP_KEY}.csvref`)).toBeNull();
    });

    it("a different file after a confirmed upload is a new hand-off", async () => {
      const calls = stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? new Response(JSON.stringify({ jobId: "j", message: "ok" }), { status: 201 }) : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      await screen.findByText(/^ok$/);
      const other = new File(["name\nB"], "other.csv", { type: "text/csv", lastModified: 1_700_000_000_001 });
      fireEvent.change(screen.getByLabelText("Choose a CSV file of your members"), { target: { files: [other] } });
      fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
      await waitFor(() => expect(calls.filter((c) => c.url === "/api/onboarding/csv-handoff")).toHaveLength(2));
      const [a, b] = calls.filter((c) => c.url === "/api/onboarding/csv-handoff");
      expect(refOf(b)).not.toBe(refOf(a));
    });

    it("a 403 with a technical or missing reason gets plain words", async () => {
      stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? fail(403, "Invalid Referer") : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      const t = (await screen.findByRole("alert")).textContent ?? "";
      expect(t).toMatch(/wasn't sent: access was refused\. Refresh the page/);
      expect(t).not.toMatch(/Referer/);
    });

    it("the server's notesMatch decides the notes warning when it has a record", async () => {
      let n = 0;
      stubFetch((url) => {
        if (url !== "/api/onboarding/csv-handoff") return ok();
        n++;
        if (n === 1) return "throw";
        return new Response(JSON.stringify({ jobId: "j1", message: "We already have this file.", alreadyReceived: true, notesMatch: true }), { status: 200 });
      });
      openAt(9);
      renderWizard();
      await pickAndUpload();
      await screen.findByText(/couldn't confirm your file arrived/i);
      // Local notes changed, but the server says what it stored matches: no warning.
      fireEvent.change(screen.getByLabelText("Notes about your CSV file"), { target: { value: "something else" } });
      fireEvent.click(screen.getByRole("button", { name: /^upload csv/i }));
      await screen.findByText(/we already have this file/i);
      expect(screen.queryByText(/notes you changed/i)).toBeNull();
    });

    it("a 503 that is not ours (no JSON error) is treated as unconfirmed, retry-safe", async () => {
      stubFetch((url) => (url === "/api/onboarding/csv-handoff" ? new Response("<html>Service Unavailable</html>", { status: 503 }) : ok()));
      openAt(9);
      renderWizard();
      await pickAndUpload();
      expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't confirm your file arrived/i);
    });
  });
});

describe("setup-banner links open the real page", () => {
  function tx(over: Partial<{ stripeConnected: boolean; members: number }> = {}) {
    return {
      tenant: {
        findUnique: async () => ({
          stripeConnected: over.stripeConnected ?? false,
          onboardingCompleted: true,
          contactEmail: "desk@club.test",
          billingContactEmail: null,
        }),
      },
      membershipTier: { count: async () => 1 },
      class: { count: async () => 1 },
      member: { count: async () => over.members ?? 0 },
    } as unknown as Parameters<typeof getSetupGaps>[0];
  }

  it("Stripe and members go to Settings tabs, never back into the wizard", async () => {
    const gaps = await getSetupGaps(tx(), "t1", "owner");
    expect(gaps).toEqual([
      { label: "Connect Stripe", href: "/dashboard/settings?tab=revenue" },
      { label: "Add your first members", href: "/dashboard/settings?tab=import" },
    ]);
    expect(gaps.some((g) => g.href.startsWith("/onboarding"))).toBe(false);
  });

  it("staff see no banner", async () => {
    expect(await getSetupGaps(tx(), "t1", "manager")).toEqual([]);
  });
});
