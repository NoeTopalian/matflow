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
  it("a 400 keeps the owner on step 1 with the failure message", async () => {
    stubFetch(() => fail(400));
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error"));
    expect(screen.getByLabelText("Gym Name")).toBeTruthy();
    expect(screen.queryByText(/what do you teach/i)).toBeNull();
  });

  it("a network failure keeps the owner on step 1 with the failure message", async () => {
    stubFetch(() => "throw");
    renderWizard({ storedTimezone: DEVICE_ZONE });
    fireEvent.change(screen.getByLabelText("Gym Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error"));
    expect(screen.queryByText(/what do you teach/i)).toBeNull();
  });

  it("a failed questionnaire save keeps the owner on step 6", async () => {
    const calls = stubFetch(() => fail(500));
    openAt(6);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "21–50" }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error"));
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
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't finish setup/i), "error"));
    expect(patches(calls).map((c) => c.body)).toEqual([{ onboardingCompleted: true }]);
    expect(screen.getByText(/bring your members across/i)).toBeTruthy();
  });

  it("a failed completion save never shows the ready screen (Skip)", async () => {
    stubFetch(() => "throw");
    openAt(9);
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't finish setup/i), "error"));
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
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/some ranks didn't save/i), "error"));
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
    expect(calls.filter((c) => c.url === "/api/classes")).toHaveLength(1);
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
    const calls = stubFetch((url) => {
      if (url === "/api/classes") return ++classPosts === 2 ? fail(503) : ok({ id: `c${classPosts}` });
      return ok();
    });
    openAt(4);
    renderWizard();
    await screen.findByText(/add your classes/i);
    addMondayClass("Fundamentals");
    addMondayClass("No-Gi");
    fireEvent.click(screen.getByRole("button", { name: /save 2 classes/i }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/some classes didn't save/i), "error"));
    expect(screen.getByText(/add your classes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /save 2 classes/i }));
    await waitFor(() => expect(screen.queryByText(/add your classes/i)).toBeNull());
    const names = calls.filter((c) => c.url === "/api/classes").map((c) => (c.body as { name: string }).name);
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
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/sign in again/i), "error"));
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
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/couldn't confirm that saved/i), "error"));
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
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/didn't upload: File too large.*Nothing on this page has been saved/), "error", 8000));
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
