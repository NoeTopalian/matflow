// The webhook endpoint must be subscribed to every event type the route
// handles, or that feature never runs in production (28 Oct 2026: the setup
// script's list had drifted six types behind, including both async checkout
// events, so a delayed-method class-pack payment would never mint credits).
//
// The setup script runs Stripe calls at top level, so it is read as text, not
// imported. The route is read as text too: every `event.type === "..."` branch
// it dispatches on must be handled and subscribed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLED_STRIPE_EVENT_TYPES } from "@/lib/stripe/handled-events";

const root = process.cwd();
const script = readFileSync(join(root, "scripts/setup-stripe-webhook.mjs"), "utf8");
const route = readFileSync(join(root, "app/api/stripe/webhook/route.ts"), "utf8");

function desiredEvents(): string[] {
  const block = /const DESIRED_EVENTS = \[([\s\S]*?)\]\.sort\(\);/.exec(script);
  if (!block) throw new Error("DESIRED_EVENTS not found in scripts/setup-stripe-webhook.mjs");
  return [...block[1].matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
}

function routeBranchTypes(): string[] {
  return [...new Set([...route.matchAll(/event\.type === "([a-z_.]+)"/g)].map((m) => m[1]))];
}

describe("Stripe webhook subscription list (scripts/setup-stripe-webhook.mjs DESIRED_EVENTS)", () => {
  it("parses a non-trivial list with no duplicates", () => {
    const desired = desiredEvents();
    expect(desired.length).toBeGreaterThan(10);
    expect(new Set(desired).size).toBe(desired.length);
  });

  it("subscribes every handled event type", () => {
    const desired = new Set(desiredEvents());
    const missing = [...HANDLED_STRIPE_EVENT_TYPES].filter((t) => !desired.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("subscribes nothing the route does not handle (an unhandled type is claimed by no one)", () => {
    const extra = desiredEvents().filter((t) => !HANDLED_STRIPE_EVENT_TYPES.has(t)).sort();
    expect(extra).toEqual([]);
  });

  it("covers every event type the route dispatches on, including both async checkout events", () => {
    const desired = new Set(desiredEvents());
    const branches = routeBranchTypes();
    expect(branches).toContain("checkout.session.async_payment_succeeded");
    expect(branches).toContain("checkout.session.async_payment_failed");
    const notHandled = branches.filter((t) => !HANDLED_STRIPE_EVENT_TYPES.has(t)).sort();
    const notSubscribed = branches.filter((t) => !desired.has(t)).sort();
    expect(notHandled).toEqual([]);
    expect(notSubscribed).toEqual([]);
  });

  it("matches the GO-LIVE runbook's event list", () => {
    const runbook = readFileSync(join(root, "docs/runbooks/GO-LIVE-2026-09.md"), "utf8");
    const step = /7\. \*\*Select events\*\*([\s\S]*?)\n8\. /.exec(runbook);
    if (!step) throw new Error("GO-LIVE step 7 not found");
    const listed = new Set([...step[1].matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)].map((m) => m[1]));
    expect([...listed].sort()).toEqual([...desiredEvents()].sort());
  });
});
