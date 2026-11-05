// New activity events go through one door (lib/activity-events.ts): a closed
// shape per event, ids and amounts only, nothing about an erased member.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ logAudit: vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));

import { ACTIVITY_EVENT_ACTIONS, ACTIVITY_EVENT_SCHEMAS, logActivityEvent, type ActivityEventAction } from "@/lib/activity-events";
import { AUDIT_LABELS } from "@/lib/audit-labels";
import { typeKeyForAction, activityType } from "@/lib/activity-types";
import { applyUndo, decideUndo, UNDO_HANDLERS } from "@/lib/undo-registry";

const VALID: Record<ActivityEventAction, Record<string, unknown>> = {
  "member.subscription.purchased": { memberId: "cmember000000000000000001", tierId: "ctier00000000000000000001", stripeSubscriptionId: "sub_1QabcDEF234" },
  "class_pack.purchased": { memberId: "m1", classPackId: "p1", memberClassPackId: "mcp1", credits: 10, amountPence: 8000, currency: "GBP" },
  "order.paid": { memberId: "m1", orderId: "o1", orderRef: "TB-00042", amountPence: 2500, currency: "gbp" },
  "class.booking.created": { memberId: "m1", classId: "seed-class-AdvancedNoGi" },
  "class.booking.cancelled": { memberId: "m1", classId: "c1" },
};

beforeEach(() => {
  h.logAudit.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the shapes", () => {
  it("there is one for each new event, and each accepts what its writer sends", () => {
    expect([...ACTIVITY_EVENT_ACTIONS].sort()).toEqual(Object.keys(VALID).sort());
    for (const action of ACTIVITY_EVENT_ACTIONS) expect(ACTIVITY_EVENT_SCHEMAS[action].safeParse(VALID[action]).success, action).toBe(true);
  });

  it.each(["name", "title", "message", "subject", "recipient", "email", "kind", "note"])("none of them takes a key called %s", (key) => {
    for (const action of ACTIVITY_EVENT_ACTIONS) {
      expect(ACTIVITY_EVENT_SCHEMAS[action].safeParse({ ...VALID[action], [key]: "free text" }).success, `${action} + ${key}`).toBe(false);
    }
  });

  it("an id is an id, pence are whole and not negative, a currency is three letters", () => {
    const bad: [ActivityEventAction, Record<string, unknown>][] = [
      ["class.booking.created", { memberId: "m 1", classId: "c1" }],
      ["class.booking.created", { memberId: "m1", classId: "c/1" }],
      ["class.booking.created", { memberId: "m1" }],
      ["class_pack.purchased", { ...VALID["class_pack.purchased"], amountPence: 80.5 }],
      ["class_pack.purchased", { ...VALID["class_pack.purchased"], amountPence: -1 }],
      ["class_pack.purchased", { ...VALID["class_pack.purchased"], credits: 0 }],
      ["class_pack.purchased", { ...VALID["class_pack.purchased"], currency: "POUNDS" }],
      ["order.paid", { ...VALID["order.paid"], orderRef: "" }],
      ["member.subscription.purchased", { ...VALID["member.subscription.purchased"], stripeSubscriptionId: "price_123" }],
    ];
    for (const [action, metadata] of bad) expect(ACTIVITY_EVENT_SCHEMAS[action].safeParse(metadata).success, `${action} ${JSON.stringify(metadata)}`).toBe(false);
  });

  it("a membership started on a price that maps to no plan, and a shop order with no member, are still events", () => {
    expect(ACTIVITY_EVENT_SCHEMAS["member.subscription.purchased"].safeParse({ ...VALID["member.subscription.purchased"], tierId: null }).success).toBe(true);
    expect(ACTIVITY_EVENT_SCHEMAS["order.paid"].safeParse({ ...VALID["order.paid"], memberId: null }).success).toBe(true);
  });
});

describe("logActivityEvent", () => {
  it("files the row under the member, with the caller's transaction and request id", async () => {
    const tx = { marker: "tx" };
    const wrote = await logActivityEvent("class_pack.purchased", VALID["class_pack.purchased"] as never, { tenantId: "t1", userId: null, tx: tx as never });
    expect(wrote).toBe(true);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    expect(h.logAudit.mock.calls[0][0]).toEqual({ tenantId: "t1", userId: null, tx, action: "class_pack.purchased", entityType: "Member", entityId: "m1", metadata: VALID["class_pack.purchased"] });
    await logActivityEvent("member.subscription.purchased", VALID["member.subscription.purchased"] as never, { tenantId: "t1", userId: "u_staff", durable: true, requestId: "sub-purchased:sub_1QabcDEF234" });
    expect(h.logAudit.mock.calls[1][0]).toMatchObject({ durable: true, requestId: "sub-purchased:sub_1QabcDEF234", userId: "u_staff", entityType: "Member", entityId: "cmember000000000000000001" });
  });

  it("a shop order with no member on it is filed under the order", async () => {
    await logActivityEvent("order.paid", { ...VALID["order.paid"], memberId: null } as never, { tenantId: "t1", entity: { type: "Order", id: "o1" } });
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({ entityType: "Order", entityId: "o1" });
  });

  it("in tests and development, metadata outside the shape is a thrown error — and the message names keys, never values", async () => {
    await expect(logActivityEvent("class.booking.created", { memberId: "m1", classId: "c1", name: "Jane Smith" } as never, { tenantId: "t1" })).rejects.toThrow(/class\.booking\.created was given metadata it does not allow/);
    await expect(logActivityEvent("class.booking.created", { memberId: "m1", classId: "c1", name: "Jane Smith" } as never, { tenantId: "t1" })).rejects.not.toThrow(/Jane/);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("in production an extra key is dropped and the event is still recorded", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrote = await logActivityEvent("class.booking.created", { memberId: "m1", classId: "c1", name: "Jane Smith" } as never, { tenantId: "t1" });
    expect(wrote).toBe(true);
    expect(h.logAudit.mock.calls[0][0].metadata).toEqual({ memberId: "m1", classId: "c1" });
    expect(JSON.stringify(said.mock.calls)).not.toContain("Jane");
  });

  it("in production a value that is not what the shape asks for is not written, and nothing is thrown at the purchase", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const wrote = await logActivityEvent("class_pack.purchased", { ...VALID["class_pack.purchased"], amountPence: "eighty" } as never, { tenantId: "t1" });
    expect(wrote).toBe(false);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("writes nothing about a member who has been erased", async () => {
    const wrote = await logActivityEvent("class_pack.purchased", VALID["class_pack.purchased"] as never, { tenantId: "t1", memberEmail: "deleted-cmember@deleted.invalid" });
    expect(wrote).toBe(false);
    expect(h.logAudit).not.toHaveBeenCalled();
    expect(await logActivityEvent("class_pack.purchased", VALID["class_pack.purchased"] as never, { tenantId: "t1", memberEmail: "jane@example.test" })).toBe(true);
  });

  it("a failed write is the caller's to know about: inside a transaction it must roll the purchase back with it", async () => {
    h.logAudit.mockRejectedValueOnce(new Error("insert failed"));
    await expect(logActivityEvent("order.paid", VALID["order.paid"] as never, { tenantId: "t1", tx: {} as never })).rejects.toThrow("insert failed");
  });
});

describe("each new event is known everywhere a row is read", () => {
  it("has a label, a type other than Other, and a reason it cannot be undone", () => {
    for (const action of ACTIVITY_EVENT_ACTIONS) {
      expect(AUDIT_LABELS[action], `label for ${action}`).toBeTruthy();
      const type = typeKeyForAction(action);
      expect(type, `type for ${action}`).not.toBe("other");
      expect(activityType(type)!.roles, `${action} is club life: managers see it`).toContain("manager");
      const undo = decideUndo({ action, metadata: VALID[action] } as never, false);
      expect(undo.ok, action).toBe(false);
    }
  });

  it("the reasons say what to do instead", () => {
    const reason = (action: ActivityEventAction) => {
      const d = decideUndo({ action, metadata: VALID[action] } as never, false);
      return d.ok ? "" : d.reason;
    };
    expect(reason("member.subscription.purchased")).toBe("This started a Stripe subscription. Cancel it from the member's profile so Stripe is told too.");
    // One sentence for money, wherever it moved: the same as a payment's.
    expect(reason("class_pack.purchased")).toBe("Money moved — reverse it from Payments (refund), not from here.");
    expect(reason("order.paid")).toBe("Money moved — reverse it from Payments (refund), not from here.");
    expect(reason("class.booking.created")).toBe("The member can cancel the booking from their app.");
    expect(reason("class.booking.cancelled")).toBe("The member can book again from their app.");
  });

  it("none of them has an undo handler: asking to undo one is an error, not a silent success", async () => {
    for (const action of ACTIVITY_EVENT_ACTIONS) {
      expect(UNDO_HANDLERS[action], action).toBeUndefined();
      await expect(applyUndo({} as never, { action, metadata: VALID[action] } as never), action).rejects.toThrow(`No undo handler for ${action}`);
    }
  });
});

describe("something that was added says so, instead of blaming a missing snapshot", () => {
  const reasonFor = (action: string) => {
    const d = decideUndo({ action, metadata: {} } as never, false);
    return d.ok ? "" : d.reason;
  };
  // "Remove or archive": a class is archived and a pack switched off; neither is deleted.
  const ADDED = "This added something new, so there is nothing earlier to put back. If it was a mistake, remove or archive it where it lives.";

  it.each(["class.created", "member.create", "member.create.kid", "announcement.created", "rank.created", "membership.tier.create", "class_pack.create", "location.create"])("%s", (action) => {
    expect(reasonFor(action)).toBe(ADDED);
  });

  // A task or a note cannot be removed at all: it is closed.
  it.each(["task.staff_task.create", "task.member_note.create"])("%s is closed, not removed", (action) => {
    expect(reasonFor(action)).toBe("This added a task or a note, so there is nothing earlier to put back. Close it by marking it done on the Tasks page.");
  });

  it("more specific reasons still win, and an edit recorded without its old values keeps the snapshot reason", () => {
    expect(reasonFor("member.subscription.create.kid")).toBe("This talked to Stripe. Undo it from the member's profile so Stripe is told too.");
    expect(reasonFor("membership.tier.price_created")).toBe("Recorded before snapshots were kept, so the previous values aren't known.");
    expect(reasonFor("member.update")).toBe("Recorded before snapshots were kept, so the previous values aren't known.");
  });
});

// ── One door ─────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("every writer of a new event goes through logActivityEvent", () => {
  /** Files that name the actions to describe them, not to write them. */
  const READERS = new Set(["lib/activity-events.ts", "lib/audit-labels.ts", "lib/activity-types.ts", "lib/activity-feed.ts", "lib/undo-registry.ts"]);
  /** The action as the first argument of logActivityEvent, on the same line or the next. */
  const throughDoor = (action: string) => new RegExp(`logActivityEvent\\(\\s*"${action.replace(/\./g, "\\.")}"`, "g");
  const sources = [...walk("app"), ...walk("lib")].map((file) => ({ file: file.replace(/\\/g, "/"), src: readFileSync(file, "utf8") }));

  it("no file writes one with logAudit directly", () => {
    const direct: string[] = [];
    for (const { file, src } of sources) {
      if (READERS.has(file)) continue;
      for (const action of ACTIVITY_EVENT_ACTIONS) {
        // Any mention of the name that is not the first argument of logActivityEvent.
        const mentions = src.split(`"${action}"`).length - 1;
        const through = [...src.matchAll(throughDoor(action))].length;
        if (mentions > through) direct.push(`${file}: ${action}`);
      }
    }
    expect(direct, direct.join("; ")).toEqual([]);
  });

  it("each event has at least one writer", () => {
    for (const action of ACTIVITY_EVENT_ACTIONS) {
      expect(sources.some(({ src }) => throughDoor(action).test(src)), `nothing writes ${action}`).toBe(true);
    }
  });
});
