// Round 12 G-2: settings stored outside PATCH /api/settings are described too, and each entry names the route and the
// gate that decides who may change it. The test reads every route so the registry cannot claim a gate that is not there.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_SETTINGS, SETTINGS_KEYS, externalSettingSpec } from "@/lib/settings-registry";

const ROOT = join(__dirname, "..", "..");

describe("external settings registry", () => {
  it("every entry's route exists and contains the gate it names", () => {
    for (const s of EXTERNAL_SETTINGS) {
      const file = join(ROOT, s.route);
      expect(existsSync(file), s.route).toBe(true);
      expect(readFileSync(file, "utf8").includes(s.gate), `${s.key}: ${s.gate} in ${s.route}`).toBe(true);
    }
  });

  it("the roles match the gate", () => {
    for (const s of EXTERNAL_SETTINGS) {
      const roles = [...s.editRoles].sort().join(",");
      if (s.gate === "requireApiOwnerOrManager") expect(roles, s.key).toBe("manager,owner");
      else if (s.gate === "requireApiOwner" || s.gate === 'role !== "owner"') expect(roles, s.key).toBe("owner");
      else expect(roles, s.key).toBe("admin,manager,owner");
    }
  });

  it("every entry answers the five questions", () => {
    for (const s of EXTERNAL_SETTINGS) {
      expect(s.what.length, s.key).toBeGreaterThan(5);
      expect(s.where.length, s.key).toBeGreaterThan(0);
      expect(["staff", "members", "members and staff", "nobody yet"]).toContain(s.who);
      expect(["immediately", "next sign-in", "next page load"]).toContain(s.when);
      expect(s.undo, s.key).toMatch(/edit back/);
      if (s.group === "money") expect(s.inheritable, s.key).toBe(false);
    }
  });

  it("keys are unique and never overlap the /api/settings keys", () => {
    const keys = EXTERNAL_SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(SETTINGS_KEYS, k).not.toContain(k);
    expect(externalSettingSpec("leaderboardOptOut")?.scope).toBe("member");
  });
});
