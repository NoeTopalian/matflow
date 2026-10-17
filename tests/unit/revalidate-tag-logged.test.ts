/**
 * T2c (17 Oct 2026): `revalidateTag` failures are logged, never swallowed and
 * never rethrown. The settings PATCH and the settings undo used to wrap the
 * call in an empty `catch {}`.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const { revalidateTagMock } = vi.hoisted(() => ({ revalidateTagMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: revalidateTagMock }));

import { revalidateTagLogged, tagKind } from "@/lib/revalidate-tag-logged";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  revalidateTagMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("revalidateTagLogged", () => {
  it("revalidates the tag with immediate expiry and logs nothing on success", () => {
    expect(revalidateTagLogged("gym-branding-t_1", "t_1")).toBe(true);
    expect(revalidateTagMock).toHaveBeenCalledWith("gym-branding-t_1", { expire: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("on a throw: does not rethrow, returns false, and logs exactly one structured warning with the tag kind and tenantId only", () => {
    revalidateTagMock.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing for jo@example.com");
    });
    expect(() => revalidateTagLogged("gym-branding-t_1", "t_1")).not.toThrow();
    expect(revalidateTagLogged("gym-branding-t_1", "t_1")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    const [msg, payload] = warn.mock.calls[0];
    expect(msg).toBe("[cache] revalidateTag failed");
    expect(payload).toEqual({
      event: "revalidate_tag_failed",
      tagKind: "gym-branding",
      tenantId: "t_1",
      errorName: "Error",
    });
    // The error message (which could carry anything) is never logged.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("example.com");
  });

  it("a non-Error throw is still logged and swallowed", () => {
    revalidateTagMock.mockImplementation(() => {
      throw "boom";
    });
    expect(revalidateTagLogged("reports-t_9", "t_9")).toBe(false);
    expect(warn.mock.calls[0][1]).toMatchObject({ tagKind: "reports", tenantId: "t_9", errorName: "string" });
  });

  it("tagKind strips only the tenant suffix", () => {
    expect(tagKind("gym-branding-t_1", "t_1")).toBe("gym-branding");
    expect(tagKind("reports-abc", "abc")).toBe("reports");
    expect(tagKind("leaderboard", "t_1")).toBe("leaderboard");
  });

  it("both former swallow sites use the helper; no empty catch around revalidateTag remains", () => {
    for (const file of ["app/api/settings/route.ts", "lib/undo-registry.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("revalidateTagLogged(`gym-branding-");
      expect(src).not.toMatch(/import \{ revalidateTag \} from "next\/cache"/);
      expect(src).not.toMatch(/revalidateTag\([^)]*\);?\s*\}\s*catch/);
    }
  });
});
