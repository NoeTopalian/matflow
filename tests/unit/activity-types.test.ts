// The activity-type taxonomy: every audit action belongs to exactly one type,
// every type says who may see it, and the keys people have in links and saved
// defaults never change under them.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_LABELS } from "@/lib/audit-labels";
import {
  ACTIVITY_FIELD_LABELS,
  ACTIVITY_GROUPS,
  ACTIVITY_TYPES,
  ACTIVITY_VIEWS,
  RETIRED_TYPE_KEYS,
  activityType,
  defaultTypeKeys,
  fieldLabel,
  parseTypesParam,
  readStoredActivityDefault,
  typeKeyForAction,
  visibleTypeKeys,
} from "@/lib/activity-types";

const keys = ACTIVITY_TYPES.map((t) => t.key);
const matches = (action: string) => ACTIVITY_TYPES.filter((t) => t.actions.includes(action) || t.prefixes.some((p) => action.startsWith(p))).map((t) => t.key);

describe("every action has exactly one type", () => {
  it("each labelled action is named by one type and only one", () => {
    const wrong = Object.keys(AUDIT_LABELS)
      .map((action) => [action, matches(action)] as const)
      .filter(([, found]) => found.length !== 1);
    expect(wrong, `not exactly one type: ${wrong.map(([a, f]) => `${a} -> [${f.join(", ")}]`).join("; ")}`).toEqual([]);
  });

  it("names minted at run time land by prefix; anything else is Other", () => {
    expect(typeKeyForAction("stripe.dispute.needs_response")).toBe("payment_failed");
    expect(typeKeyForAction("undo.member.update")).toBe("undo");
    expect(typeKeyForAction("something.nobody.listed")).toBe("other");
  });

  it("every action a type names is a labelled action", () => {
    const unlabelled = ACTIVITY_TYPES.flatMap((t) => [...t.actions, ...t.ruleActions]).filter((a) => !(a in AUDIT_LABELS));
    expect(unlabelled).toEqual([]);
  });

  it("a row-rule action is also some type's plain action, so a row the rule does not claim still has a type", () => {
    for (const t of ACTIVITY_TYPES) for (const action of t.ruleActions) expect(matches(action), action).toHaveLength(1);
  });
});

describe("types are well formed and their keys are permanent", () => {
  it("has the exact key list — never rename or remove a key; retire it in RETIRED_TYPE_KEYS", () => {
    expect(keys).toEqual([
      "checkin_exception",
      "checkin",
      "checkin_removed",
      "member_joined",
      "rank",
      "hold",
      "waiver",
      "member_removed",
      "member_updated",
      "member_access",
      "membership_started",
      "membership_changed",
      "cancellation",
      "payment",
      "payment_failed",
      "refund",
      "payment_reminder",
      "billing_details",
      "session_cancelled",
      "class_changed",
      "announcement",
      "task",
      "rank_setup",
      "plan_setup",
      "support",
      "undo",
      "data_request",
      "staff",
      "sign_in",
      "settings",
      "import",
      "other",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [old, current] of Object.entries(RETIRED_TYPE_KEYS)) {
      expect(keys, `retired key ${old} must not be reused`).not.toContain(old);
      expect(keys).toContain(current);
    }
  });

  it("each has a label that fits the Type column, an icon, a known group and at least one role", () => {
    for (const t of ACTIVITY_TYPES) {
      expect(t.label.length, t.key).toBeLessThanOrEqual(26);
      expect(t.label, t.key).toMatch(/^[A-Z]/);
      expect(t.icon, t.key).toMatch(/^[A-Z][A-Za-z0-9]+$/);
      expect(ACTIVITY_GROUPS, t.key).toContain(t.group);
      expect(t.roles.length, t.key).toBeGreaterThan(0);
      expect(t.roles, t.key).toContain("owner");
    }
  });

  it("only run-time names use a prefix", () => {
    expect(ACTIVITY_TYPES.flatMap((t) => t.prefixes).sort()).toEqual(["stripe.dispute.", "undo."]);
  });
});

describe("who sees what", () => {
  it("a manager never sees staff, security, settings, data requests, support, undo, imports, plan set-up or Other", () => {
    const manager = visibleTypeKeys("manager");
    for (const key of ["staff", "sign_in", "settings", "data_request", "support", "undo", "import", "plan_setup", "other"]) expect(manager, key).not.toContain(key);
  });

  it("a manager sees club life, including money", () => {
    const manager = visibleTypeKeys("manager");
    for (const key of ["checkin", "member_joined", "member_updated", "rank", "class_changed", "payment", "payment_failed", "refund", "cancellation", "membership_changed", "rank_setup"]) expect(manager, key).toContain(key);
  });

  it("the owner sees every type", () => {
    expect(visibleTypeKeys("owner")).toEqual(keys);
  });

  it("Club activity leaves out the noisy types, and keeps the trust record for the owner", () => {
    const owner = defaultTypeKeys("owner");
    for (const key of ["staff", "sign_in", "settings", "import", "data_request", "member_access", "billing_details"]) expect(owner, key).not.toContain(key);
    for (const key of ["support", "undo", "other", "plan_setup", "checkin", "payment"]) expect(owner, key).toContain(key);
    const manager = defaultTypeKeys("manager");
    expect(manager.every((k) => visibleTypeKeys("manager").includes(k))).toBe(true);
    expect(manager).not.toContain("support");
  });
});

describe("views", () => {
  it("has the five views, each made of real types the role may see", () => {
    expect(ACTIVITY_VIEWS.map((v) => v.key)).toEqual(["club", "attendance", "money", "staff_changes", "all"]);
    for (const role of ["owner", "manager"] as const) {
      const visible = visibleTypeKeys(role);
      for (const view of ACTIVITY_VIEWS) {
        const viewKeys = view.typeKeys(role);
        expect(viewKeys.length, `${view.key} for ${role}`).toBeGreaterThan(0);
        for (const k of viewKeys) expect(visible, `${view.key} for ${role}`).toContain(k);
      }
    }
  });

  it("Money is the money group; Staff changes holds what staff changed", () => {
    expect(ACTIVITY_VIEWS.find((v) => v.key === "money")!.typeKeys("owner")).toEqual(ACTIVITY_TYPES.filter((t) => t.group === "Memberships & money").map((t) => t.key));
    const staffChanges = ACTIVITY_VIEWS.find((v) => v.key === "staff_changes")!;
    expect(staffChanges.typeKeys("owner")).toEqual(expect.arrayContaining(["member_updated", "class_changed", "plan_setup", "settings", "undo"]));
    expect(staffChanges.typeKeys("manager")).not.toContain("settings");
  });
});

describe("parseTypesParam", () => {
  it("absent or empty is the default view", () => {
    for (const raw of [null, undefined, "", "  "]) expect(parseTypesParam(raw, "owner")).toEqual({ view: "club", keys: defaultTypeKeys("owner"), ignored: [], dropped: [] });
  });

  it("reads a view key, resolved for the role", () => {
    expect(parseTypesParam("all", "manager")).toEqual({ view: "all", keys: visibleTypeKeys("manager"), ignored: [], dropped: [] });
    expect(parseTypesParam("money", "owner").view).toBe("money");
  });

  it("reads a list, in the order given, without repeats", () => {
    expect(parseTypesParam("refund, checkin,refund", "owner")).toEqual({ view: null, keys: ["refund", "checkin"], ignored: [], dropped: [] });
  });

  it("ignores keys that are not types and says which", () => {
    expect(parseTypesParam("checkin,bogus", "owner")).toEqual({ view: null, keys: ["checkin"], ignored: ["bogus"], dropped: [] });
  });

  it("falls back to the default when nothing usable is left, still saying what was ignored", () => {
    expect(parseTypesParam("bogus", "owner")).toEqual({ view: "club", keys: defaultTypeKeys("owner"), ignored: ["bogus"], dropped: [] });
  });

  it("drops the types a manager may not see, and says which", () => {
    expect(parseTypesParam("checkin,staff,support", "manager")).toEqual({ view: null, keys: ["checkin"], ignored: [], dropped: ["staff", "support"] });
    expect(parseTypesParam("staff", "manager")).toEqual({ view: "club", keys: defaultTypeKeys("manager"), ignored: [], dropped: ["staff"] });
    expect(parseTypesParam("checkin,staff", "owner").keys).toEqual(["checkin", "staff"]);
  });

  it("takes at most forty keys and reads nothing from an over-long value", () => {
    const many = Array.from({ length: 45 }, (_, i) => `x${i}`).join(",");
    const parsed = parseTypesParam(`checkin,${many}`, "owner");
    expect(parsed.keys).toEqual(["checkin"]);
    expect(parsed.ignored).toHaveLength(45);
    expect(parseTypesParam("checkin,".repeat(200), "owner")).toEqual({ view: "club", keys: defaultTypeKeys("owner"), ignored: [], dropped: [] });
  });
});

describe("readStoredActivityDefault", () => {
  const known = keys;
  const stored = (value: unknown) => JSON.stringify(value);

  it("is null for nothing, garbage or another version", () => {
    expect(readStoredActivityDefault(null, "owner")).toBeNull();
    expect(readStoredActivityDefault("{not json", "owner")).toBeNull();
    expect(readStoredActivityDefault(stored([1, 2]), "owner")).toBeNull();
    expect(readStoredActivityDefault(stored({ v: 2, view: "money", known }), "owner")).toBeNull();
    expect(readStoredActivityDefault(stored({ v: 1, view: "money" }), "owner")).toBeNull();
  });

  it("returns a stored view, resolved for the role", () => {
    expect(readStoredActivityDefault(stored({ v: 1, view: "money", known }), "manager")).toEqual({ view: "money", keys: ACTIVITY_VIEWS.find((v) => v.key === "money")!.typeKeys("manager") });
    expect(readStoredActivityDefault(stored({ v: 1, view: "gone", known }), "owner")).toBeNull();
  });

  it("returns a stored list, dropping unknown keys and keys the role may not see", () => {
    expect(readStoredActivityDefault(stored({ v: 1, shown: ["refund", "checkin", "bogus", "staff"], known }), "manager")).toEqual({ view: null, keys: ["checkin", "refund"] });
    expect(readStoredActivityDefault(stored({ v: 1, shown: ["staff"], known }), "manager")).toBeNull();
  });

  it("a type added since the default was saved takes its product default", () => {
    const before = known.filter((k) => k !== "rank" && k !== "member_access");
    const result = readStoredActivityDefault(stored({ v: 1, shown: ["checkin"], known: before }), "owner");
    // "rank" is on by default and was not known when this was saved; "member_access" is off by default.
    expect(result).toEqual({ view: null, keys: ["checkin", "rank"] });
  });
});

describe("field names", () => {
  it("every field the member edit can record has a name of its own", () => {
    const route = readFileSync(join("app", "api", "members", "[id]", "route.ts"), "utf8");
    const list = /const DIFFABLE = \[([\s\S]*?)\] as const/.exec(route)?.[1] ?? "";
    const fields = [...list.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(10);
    expect(fields.filter((f) => !(f in ACTIVITY_FIELD_LABELS))).toEqual([]);
  });

  it("puts an unlisted column name into words, never showing it raw", () => {
    expect(fieldLabel("emergencyContactName")).toBe("Emergency contact");
    expect(fieldLabel("someNewThingId")).toBe("Some new thing");
    expect(fieldLabel("allowed_tier_ids")).toBe("Allowed tier");
    expect(fieldLabel("checkinWindowBeforeMin")).toBe("Checkin window before min");
    for (const label of Object.values(ACTIVITY_FIELD_LABELS)) expect(label).not.toMatch(/[a-z][A-Z]|_/);
  });
});

// ── No filter ships without a writer ─────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("every type has a writer in the product", () => {
  it("each type except Undone changes and Other names an action written somewhere in app/ or lib/", () => {
    const self = /[\\/]lib[\\/](activity-types|activity-feed|audit-labels)\.ts$/;
    const written = new Set<string>();
    for (const file of [...walk("app"), ...walk("lib")]) {
      if (self.test(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/\baction:/.test(line)) continue;
        for (const m of line.matchAll(/"([a-z_-]+(?:\.[a-z_-]+)+)"/g)) written.add(m[1]);
      }
    }
    const unwritten = ACTIVITY_TYPES.filter((t) => t.key !== "undo" && t.key !== "other").filter((t) => ![...t.actions, ...t.ruleActions].some((a) => written.has(a)));
    expect(unwritten.map((t) => t.key)).toEqual([]);
    // Undo rows are written as `${UNDO_PREFIX}${action}`.
    expect(readFileSync(join("lib", "undo-batch.ts"), "utf8")).toContain("UNDO_PREFIX");
    expect(activityType("undo")?.prefixes).toEqual(["undo."]);
  });
});
