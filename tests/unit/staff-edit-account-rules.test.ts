/**
 * PATCH /api/staff/[id] — an owner editing a staff member's login email or
 * password follows the same rules as the self-service flows (8 Oct 2026,
 * handover lane S-staff; gaps found by lane R, docs/runbooks/ACCOUNT-EDITING.md).
 *
 * Email: free across staff AND members of the club (opaque 409), saved
 * provisional (no verification flow exists), reset codes and sign-in links for
 * the old and new address retired, sessionVersion bumped, audited with SHA-256
 * digests only. Password: the shared strength rule (lib/password-policy.ts),
 * still a TEMPORARY password. Guards: owner only; never an owner row; never
 * another club's row; the role list never includes owner.
 *
 * The tx is a small in-memory fake that honours the where-clauses the route
 * uses (id, tenantId, role.not, email, id.not, `in`, updatedAt), so a wrong
 * filter shows up as a wrong row being touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { addLoginClaimSql } from "./login-claim-fake";
import { emailDigest } from "@/lib/login-email";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  authMock: vi.fn(),
  audits: [] as Record<string, unknown>[],
  db: {
    users: [] as Record<string, unknown>[],
    members: [] as Record<string, unknown>[],
    resets: [] as Record<string, unknown>[],
    links: [] as Record<string, unknown>[],
  },
}));

vi.mock("@/auth", () => ({ auth: h.authMock }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (a: Record<string, unknown>) => { h.audits.push(a); }),
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn(async () => "$2a$12$hashed"), compare: vi.fn(async () => false) },
}));

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ("not" in c) return !same(row[k], c.not);
      if ("in" in c) return (c.in ?? []).some((v) => same(row[k], v));
    }
    return same(row[k], cond);
  });
}
function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = (row[k] as number) + ((v as { increment: number }).increment);
    else row[k] = v;
  }
  row.updatedAt = new Date(Date.now() + 1);
}
function table(rows: Row[]) {
  return {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `new-${rows.length}`, createdAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    }),
    findFirst: vi.fn(async ({ where }: { where?: Row }) => {
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((x) => matches(x, where));
      hit.forEach((x) => apply(x, data));
      return { count: hit.length };
    }),
  };
}
const tx = {
  user: table(h.db.users),
  member: table(h.db.members),
  passwordResetToken: table(h.db.resets),
  magicLinkToken: table(h.db.links),
};
addLoginClaimSql(tx); // claim lock + holder reads (AH-01)
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
}));

import { PATCH } from "@/app/api/staff/[id]/route";
import { POST as createStaff } from "@/app/api/staff/route";

const STAFF_OLD = "della@club-a.test";
const STAFF_NEW = "della.new@club-a.test";
const MEMBER_EMAIL = "member@club-a.test";
const T0 = new Date("2026-10-01T10:00:00Z");

function seed() {
  const reset = (arr: Row[], rows: Row[]) => { arr.length = 0; arr.push(...rows); };
  reset(h.db.users, [
    { id: "u-owner", tenantId: "t-a", role: "owner", name: "Owner A", email: "owner@club-a.test", sessionVersion: 3, loginEmailProvisionalSince: null, mustChangePassword: false, tempPasswordExpiresAt: null, passwordHash: "$owner", totpEnabled: true, updatedAt: T0 },
    { id: "u-owner2", tenantId: "t-a", role: "owner", name: "Co-owner A", email: "coowner@club-a.test", sessionVersion: 1, loginEmailProvisionalSince: null, mustChangePassword: false, tempPasswordExpiresAt: null, passwordHash: "$owner2", totpEnabled: true, updatedAt: T0 },
    { id: "u-staff", tenantId: "t-a", role: "manager", name: "Della", email: STAFF_OLD, sessionVersion: 5, loginEmailProvisionalSince: null, mustChangePassword: false, tempPasswordExpiresAt: null, passwordHash: "$staff", totpEnabled: true, updatedAt: T0 },
    { id: "u-coach", tenantId: "t-a", role: "coach", name: "Coach", email: "coach@club-a.test", sessionVersion: 0, loginEmailProvisionalSince: null, mustChangePassword: false, tempPasswordExpiresAt: null, passwordHash: "$coach", totpEnabled: false, updatedAt: T0 },
    { id: "u-b-staff", tenantId: "t-b", role: "manager", name: "Other Club", email: "staff@club-b.test", sessionVersion: 2, loginEmailProvisionalSince: null, mustChangePassword: false, tempPasswordExpiresAt: null, passwordHash: "$b", totpEnabled: false, updatedAt: T0 },
  ]);
  reset(h.db.members, [
    { id: "m-1", tenantId: "t-a", email: MEMBER_EMAIL },
    { id: "m-b", tenantId: "t-b", email: "member@club-b.test" },
  ]);
  reset(h.db.resets, [
    { id: "r-old", tenantId: "t-a", email: STAFF_OLD, used: false },
    { id: "r-new", tenantId: "t-a", email: STAFF_NEW, used: false },
    { id: "r-other-club", tenantId: "t-b", email: STAFF_OLD, used: false },
  ]);
  reset(h.db.links, [
    { id: "l-old", tenantId: "t-a", email: STAFF_OLD, used: false, purpose: "login", usedAt: null },
    { id: "l-new", tenantId: "t-a", email: STAFF_NEW, used: false, purpose: "first_time_signup", usedAt: null },
    { id: "l-waiver", tenantId: "t-a", email: STAFF_OLD, used: false, purpose: "waiver", usedAt: null },
  ]);
}

const snapshot = () => JSON.parse(JSON.stringify(h.db));
const user = (id: string) => h.db.users.find((u) => u.id === id)!;
const patch = (id: string, body: Record<string, unknown>) =>
  PATCH(
    new Request(`http://localhost/api/staff/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.audits.length = 0;
  seed();
  h.authMock.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "t-a" } });
});

describe("who may call it", () => {
  it("signed out → 401, nothing written", async () => {
    h.authMock.mockResolvedValue(null);
    const before = snapshot();
    expect((await patch("u-staff", { name: "X" })).status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it.each(["manager", "admin", "coach"])("a %s → 403, nothing written", async (role) => {
    h.authMock.mockResolvedValue({ user: { id: "u-staff", role, tenantId: "t-a" } });
    const before = snapshot();
    expect((await patch("u-coach", { email: "x@club-a.test" })).status).toBe(403);
    expect(snapshot()).toEqual(before);
  });
});

describe("what it may target", () => {
  it("another owner of the club → 404, nothing written", async () => {
    const before = snapshot();
    const res = await patch("u-owner2", { email: "taken-over@club-a.test", newPassword: "TempPass1234" });
    expect(res.status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("the owner's own row → 404 (never edited here), nothing written", async () => {
    const before = snapshot();
    expect((await patch("u-owner", { name: "Me" })).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("another club's staff member (cross-tenant id) → 404, nothing written", async () => {
    const before = snapshot();
    const res = await patch("u-b-staff", { email: "hijack@club-b.test", newPassword: "TempPass1234", name: "Hijacked" });
    expect(res.status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it.each(["owner", "operator", "superadmin", "member"])("role %s is not assignable → 400, nothing written", async (role) => {
    const before = snapshot();
    expect((await patch("u-staff", { role })).status).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it("keys it does not own (tenantId, flags, security fields) are not written", async () => {
    const res = await patch("u-staff", {
      name: "Della Desk",
      tenantId: "t-b",
      loginEmailProvisionalSince: null,
      mustChangePassword: false,
      sessionVersion: 0,
      passwordHash: "$evil",
      totpEnabled: false,
    });
    expect(res.status).toBe(200);
    const u = user("u-staff");
    expect(u).toMatchObject({ name: "Della Desk", tenantId: "t-a", sessionVersion: 5, passwordHash: "$staff", totpEnabled: true });
  });
});

describe("login email", () => {
  it("an address held by a MEMBER of the club → opaque 409, nothing written", async () => {
    const before = snapshot();
    const res = await patch("u-staff", { email: MEMBER_EMAIL });
    expect(res.status).toBe(409);
    const msg = String((await res.json()).error);
    expect(msg).not.toMatch(/member|staff/i);
    expect(snapshot()).toEqual(before);
  });

  it("an address held by another STAFF user of the club → the same opaque 409", async () => {
    const before = snapshot();
    const res = await patch("u-staff", { email: "coach@club-a.test" });
    expect(res.status).toBe(409);
    expect(String((await res.json()).error)).not.toMatch(/member|staff/i);
    expect(snapshot()).toEqual(before);
  });

  it("an address used in ANOTHER club is free here", async () => {
    expect((await patch("u-staff", { email: "member@club-b.test" })).status).toBe(200);
  });

  it("a change: saved provisional, sessionVersion +1, old and new tokens retired (this club only, not waivers)", async () => {
    const res = await patch("u-staff", { email: "  Della.New@Club-A.test " });
    expect(res.status).toBe(200);
    const u = user("u-staff");
    expect(u.email).toBe(STAFF_NEW);
    expect(u.loginEmailProvisionalSince).toBeInstanceOf(Date);
    expect(u.sessionVersion).toBe(6);
    const used = (arr: Row[], id: string) => arr.find((r) => r.id === id)!.used;
    expect(used(h.db.resets, "r-old")).toBe(true);
    expect(used(h.db.resets, "r-new")).toBe(true);
    expect(used(h.db.resets, "r-other-club")).toBe(false);
    expect(used(h.db.links, "l-old")).toBe(true);
    expect(used(h.db.links, "l-new")).toBe(true);
    expect(used(h.db.links, "l-waiver")).toBe(false);
  });

  it("the audit row is written in the same transaction: if it fails, the change is not reported as done (S-1)", async () => {
    const { logAudit } = await import("@/lib/audit-log");
    vi.mocked(logAudit).mockImplementationOnce(async (args: Record<string, unknown>) => {
      expect(args.tx).toBeDefined();
      throw new Error("audit insert failed");
    });
    const res = await patch("u-staff", { email: STAFF_NEW });
    expect(res.status).toBe(500);
  });

  it("the audit row carries digests, never the addresses", async () => {
    await patch("u-staff", { email: STAFF_NEW, name: "Della Renamed" });
    expect(h.audits).toHaveLength(1);
    const a = h.audits[0];
    expect(a.action).toBe("staff.update");
    expect(a.userId).toBe("u-owner");
    expect(a.entityId).toBe("u-staff");
    const meta = a.metadata as Record<string, unknown>;
    const s = JSON.stringify(meta);
    expect(s).not.toContain(STAFF_OLD);
    expect(s).not.toContain(STAFF_NEW);
    expect(meta).toMatchObject({
      oldEmailSha256: emailDigest(STAFF_OLD),
      newEmailSha256: emailDigest(STAFF_NEW),
      provisional: true,
      retired: { resetCodes: 2, signInLinks: 2 },
      before: { name: "Della" },
      after: { name: "Della Renamed" },
    });
    // The response itself still shows the owner the address they typed.
  });

  it("re-sending the current address is not a change: no provisional mark, no sign-out, no retirement", async () => {
    const res = await patch("u-staff", { email: STAFF_OLD.toUpperCase(), name: "Della" });
    expect(res.status).toBe(200);
    const u = user("u-staff");
    expect(u.loginEmailProvisionalSince).toBeNull();
    expect(u.sessionVersion).toBe(5);
    expect(h.db.resets.find((r) => r.id === "r-old")!.used).toBe(false);
  });

  it("a stale updatedAt precondition → 409 and no token is retired", async () => {
    const res = await patch("u-staff", { email: STAFF_NEW, updatedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(user("u-staff").email).toBe(STAFF_OLD);
    expect(h.db.resets.find((r) => r.id === "r-old")!.used).toBe(false);
  });

  it("a name-only edit does not sign anyone out or touch tokens", async () => {
    const before = snapshot();
    expect((await patch("u-staff", { name: "Della Desk" })).status).toBe(200);
    expect(user("u-staff").sessionVersion).toBe(5);
    expect(user("u-staff").loginEmailProvisionalSince).toBeNull();
    expect(h.db.resets).toEqual(before.resets);
    expect(JSON.parse(JSON.stringify(h.db.links))).toEqual(before.links);
  });
});

describe("temporary password", () => {
  it.each([
    ["too short", "Short1Aa"],
    ["9 characters", "Abcdefgh1"],
    ["no upper-case", "lowercase123"],
    ["no lower-case", "UPPERCASE123"],
    ["no number", "NoNumbersHere"],
  ])("%s → 400 naming the rule, nothing written", async (_label, pw) => {
    const before = snapshot();
    const res = await patch("u-staff", { newPassword: pw });
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/10 characters/);
    expect(snapshot()).toEqual(before);
  });

  it("a strong one is saved as TEMPORARY (forced change, 72 h), signs the person out, and is never audited", async () => {
    const res = await patch("u-staff", { newPassword: "TempPass1234" });
    expect(res.status).toBe(200);
    const u = user("u-staff");
    expect(u.passwordHash).toBe("$2a$12$hashed");
    expect(u.mustChangePassword).toBe(true);
    expect(u.tempPasswordExpiresAt).toBeInstanceOf(Date);
    expect(u.sessionVersion).toBe(6);
    expect(JSON.stringify(h.audits)).not.toContain("TempPass1234");
    expect(JSON.stringify(h.audits)).not.toContain("$2a$");
  });
});

// ── Follow-ups closed 8 Oct 2026 (lead request to lane S-staff) ─────────────
describe("follow-up 1 — creating staff uses the same strength rule", () => {
  const create = (password: string) =>
    createStaff(new Request("http://localhost/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Coach", email: "new.coach@club-a.test", role: "coach", password }),
    }));

  it.each(["Short1Aa", "lowercase123", "UPPERCASE123", "NoNumbersHere"])("%s → 400 naming the rule, no row", async (pw) => {
    const n = h.db.users.length;
    const res = await create(pw);
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/10 characters/);
    expect(h.db.users.length).toBe(n);
  });

  it("a strong one creates the row with a temporary password", async () => {
    const res = await create("TempPass1234");
    expect(res.status).toBe(201);
    expect(h.db.users.at(-1)).toMatchObject({ email: "new.coach@club-a.test", mustChangePassword: true });
  });
});

describe("follow-up 2 — role counts as a change only when it differs", () => {
  it("name + the SAME role (what the edit form sends) does not sign the person out", async () => {
    expect((await patch("u-staff", { name: "Della Desk", role: "manager" })).status).toBe(200);
    expect(user("u-staff")).toMatchObject({ name: "Della Desk", role: "manager", sessionVersion: 5 });
  });

  it("a different role does", async () => {
    expect((await patch("u-staff", { role: "coach" })).status).toBe(200);
    expect(user("u-staff")).toMatchObject({ role: "coach", sessionVersion: 6 });
  });
});

describe("follow-up 3 — the owner gate is requireApiOwner, inside the route", () => {
  it.each([
    ["authenticator code still owed", { totpPending: true }],
    ["temporary password", { mustChangePassword: true }],
    ["authenticator not enrolled", { requireTotpSetup: true }],
  ])("an owner session with %s → 403, nothing written", async (_label, flags) => {
    h.authMock.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "t-a", ...flags } });
    const before = snapshot();
    expect((await patch("u-staff", { email: "x@club-a.test", newPassword: "TempPass1234" })).status).toBe(403);
    expect(snapshot()).toEqual(before);
  });

  it("a non-owner still reads the route's own wording", async () => {
    h.authMock.mockResolvedValue({ user: { id: "u-staff", role: "manager", tenantId: "t-a" } });
    const res = await patch("u-coach", { name: "X" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only owners can edit staff");
  });
});
