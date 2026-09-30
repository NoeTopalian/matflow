// Review mode (Total BJJ launch, gate G2): while Tenant.reviewLockedAt is set,
// the routes that could bill a member, invite everyone, erase or delete must
// refuse on the server with 423 and a sentence that says why.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

const findUnique = vi.fn();
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({ tenant: { findUnique } }),
}));

import { refuseIfReviewLocked, getReviewState } from "@/lib/review-lock";

beforeEach(() => findUnique.mockReset());

describe("refuseIfReviewLocked", () => {
  it("lets everything through when the club is not in review", async () => {
    findUnique.mockResolvedValue({ reviewLockedAt: null, reviewSnapshotAt: null, reviewNote: null });
    expect(await refuseIfReviewLocked("t1", "subscription_start")).toBeNull();
  });

  it("refuses with 423, a machine reason and a sentence when in review", async () => {
    findUnique.mockResolvedValue({ reviewLockedAt: new Date("2026-10-01"), reviewSnapshotAt: null, reviewNote: null });
    const res = await refuseIfReviewLocked("t1", "subscription_start");
    expect(res?.status).toBe(423);
    const body = await res!.json();
    expect(body.reason).toBe("review_locked");
    expect(body.error).toMatch(/paused while this club is in review/);
  });

  it("returns the review state for the banner", async () => {
    const at = new Date("2026-10-01T09:00:00Z");
    findUnique.mockResolvedValue({ reviewLockedAt: at, reviewSnapshotAt: at, reviewNote: "Attendance not yet imported" });
    expect(await getReviewState("t1")).toEqual({ lockedAt: at, snapshotAt: at, note: "Attendance not yet imported" });
  });
});

// Each refused route calls the guard, and calls it before its first side effect
// (a Stripe call, a DB write or an email). A static check keeps a future edit
// from quietly moving the guard below the work it is meant to stop.
const GUARDED: Array<[string, string, RegExp]> = [
  ["app/api/member/subscriptions/start/route.ts", "subscription_start", /createSubscriptionForMember|stripe\.|\.create\(/],
  ["app/api/member/subscriptions/start-for-kid/route.ts", "subscription_start", /createSubscriptionForMember|stripe\.|\.create\(/],
  ["app/api/stripe/create-subscription/route.ts", "subscription_start", /createSubscriptionForMember|stripe\.|\.create\(/],
  ["app/api/stripe/migrate-memberships/route.ts", "membership_migration", /applyMigration\(/],
  ["app/api/members/bulk-invite/route.ts", "bulk_invite", /sendEmail|\.create\(|createMany/],
  ["app/api/admin/dsar/erase/route.ts", "erase", /\.delete\(|deleteMany|\.update\(/],
  ["app/api/admin/customers/[id]/soft-delete/route.ts", "club_delete", /\.update\(/],
];

describe("review-locked routes call the guard before any side effect", () => {
  it.each(GUARDED)("%s", (file, action, sideEffect) => {
    const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const guard = src.indexOf(`refuseIfReviewLocked(`);
    expect(guard, "guard missing").toBeGreaterThan(-1);
    expect(src).toContain(`"${action}"`);
    // Only the POST handler matters for soft-delete (DELETE restores).
    const post = src.indexOf("export async function POST");
    const firstEffect = src.slice(post).search(sideEffect);
    expect(firstEffect, "no side effect found to compare against").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post + firstEffect);
  });
});
