/**
 * The settings registry (lib/settings-registry.ts) and the strict settings
 * schema (app/api/settings/route.ts) must describe the same keys: a key the
 * API accepts that the registry cannot explain has no "what / where / who /
 * when / undo", and a key the registry explains that the API refuses is a
 * dead entry. The test reads the route source so the two cannot drift
 * without one of them failing here. Precedence is pinned as well.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS, SETTINGS_KEYS, resolveSetting, describeChange, settingSpec } from "@/lib/settings-registry";

function zodKeysFromRouteSource(): string[] {
  const src = readFileSync(join(__dirname, "..", "..", "app", "api", "settings", "route.ts"), "utf8");
  const start = src.indexOf("const updateSchema = z.object({");
  const end = src.indexOf(".strict()", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
}

describe("settings registry ↔ strict schema", () => {
  it("every key the API accepts is described, and nothing else", () => {
    const zod = zodKeysFromRouteSource().sort();
    expect(zod.length).toBeGreaterThan(20);
    expect([...SETTINGS_KEYS].sort()).toEqual(zod);
  });

  it("every entry answers the five questions and names a risk", () => {
    for (const s of SETTINGS) {
      expect(s.what.length, s.key).toBeGreaterThan(5);
      expect(s.where.length, s.key).toBeGreaterThan(0);
      expect(["staff", "members", "members and staff", "nobody yet"]).toContain(s.who);
      expect(["immediately", "next sign-in", "next page load"]).toContain(s.when);
      expect(s.undo, s.key).toMatch(/edit back/);
      expect(["low", "medium", "high"]).toContain(s.risk);
    }
  });

  it("money, legal and identity never inherit from a group", () => {
    for (const s of SETTINGS) {
      if (s.group === "money" || s.group === "legal" || s.key === "name") expect(s.inheritable, s.key).toBe(false);
    }
  });

  it("keys are unique", () => {
    expect(new Set(SETTINGS_KEYS).size).toBe(SETTINGS_KEYS.length);
  });
});

describe("resolveSetting precedence", () => {
  it("club beats group beats default; group only for inheritable keys", () => {
    expect(resolveSetting("primaryColor", { club: "#111", group: "#222", productDefault: "#333" })).toEqual({ value: "#111", source: "club" });
    expect(resolveSetting("primaryColor", { club: null, group: "#222", productDefault: "#333" })).toEqual({ value: "#222", source: "group" });
    expect(resolveSetting("primaryColor", { club: null, group: null, productDefault: "#333" })).toEqual({ value: "#333", source: "default" });
    expect(resolveSetting("paymentRail", { club: null, group: "stripe", productDefault: "pay_at_desk" })).toEqual({ value: "pay_at_desk", source: "default" });
  });

  it("a location override applies only to operational keys", () => {
    expect(resolveSetting("timezone", { location: "Europe/Dublin", club: "Europe/London", productDefault: "Europe/London" })).toEqual({ value: "Europe/Dublin", source: "location" });
    expect(resolveSetting("primaryColor", { location: "#999", club: "#111", productDefault: "#333" })).toEqual({ value: "#111", source: "club" });
  });

  it("describeChange gives a dialog its five lines, and nothing for an unknown key", () => {
    const d = describeChange("waiverContent");
    expect(d).toMatchObject({ risk: "high", when: "immediately" });
    expect(d?.undo).toMatch(/existing contracts unchanged/);
    expect(describeChange("nope")).toBeNull();
    expect(settingSpec("timezone")?.group).toBe("operations");
  });
});
