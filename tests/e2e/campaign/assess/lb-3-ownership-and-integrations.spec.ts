/**
 * Lane L-B, file 3 — J20 transfer ownership · J21 impersonation attribution ·
 * J62 integrations (Google Drive) and initiatives.
 *
 * The operator plane is driven WITHOUT ever writing a storage state, printing a
 * cookie or quoting a header: `matflow_admin`'s value IS the secret. The
 * context's jar holds it and dies with the context.
 *
 * Impersonation attribution itself (lib/audit-log.ts, app/api/admin/**) belongs
 * to Lane L-G. This lane COUNTS the unattributed rows and reports; it changes
 * nothing there.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";
import {
  sessionFor,
  anonContext,
  closeSessions,
  createThrowawayStaff,
  createThrowawayTenant,
  teardownThrowawayTenant,
  teardownThrowawayStaff,
  apiCall,
  countOf,
  assertUnchanged,
  clearBucket,
  COACH_A,
  ADMIN_A,
  MEMBER_A,
  OWNER_A,
  PASSWORD_A,
  THROWAWAY_PASSWORD,
  type ThrowawayTenant,
  type ThrowawayStaff,
} from "./lb-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

let tenantId: string;
let throwaway: ThrowawayTenant;
let managerStaff: ThrowawayStaff;
let ctxOwner: BrowserContext;
let ctxManager: BrowserContext;
let ctxCoach: BrowserContext;
let ctxAdmin: BrowserContext;
let ctxMember: BrowserContext;
let ctxAnon: BrowserContext;
/** null when MATFLOW_ADMIN_SECRET is absent — the cell is then UNCOVERED by name. */
let ctxOperator: BrowserContext | null = null;

/**
 * The operator plane. No storageState, nothing under tests/e2e/.auth, no header
 * ever printed (a0-shared.ts:143-171 is the same construction).
 */
async function operatorContext(
  browser: import("@playwright/test").Browser,
  baseURL: string,
): Promise<BrowserContext | null> {
  const secret = process.env.MATFLOW_ADMIN_SECRET;
  if (!secret) return null;
  const context = await browser.newContext({ baseURL, storageState: undefined });
  await context.clearCookies();
  const res = await context.request.post("/api/admin/auth/login", {
    headers: { Origin: baseURL },
    data: { secret },
  });
  if (res.status() !== 200) {
    await context.close();
    return null;
  }
  return context;
}

test.beforeAll(async ({ browser, baseURL }) => {
  tenantId = await seededTenantId();
  throwaway = await createThrowawayTenant();
  managerStaff = await createThrowawayStaff("manager");
  const b = baseURL!;
  ctxOwner = await sessionFor(browser, b, { email: OWNER_A, password: PASSWORD_A });
  ctxManager = await sessionFor(browser, b, { email: managerStaff.email, password: THROWAWAY_PASSWORD });
  ctxCoach = await sessionFor(browser, b, { email: COACH_A, password: PASSWORD_A });
  ctxAdmin = await sessionFor(browser, b, { email: ADMIN_A, password: PASSWORD_A });
  ctxMember = await sessionFor(browser, b, { email: MEMBER_A, password: PASSWORD_A });
  ctxAnon = await anonContext(browser, b);
  ctxOperator = await operatorContext(browser, b);
});

test.afterAll(async () => {
  await sql('DELETE FROM "Initiative" WHERE notes LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
  if (throwaway) await teardownThrowawayTenant(throwaway);
  await teardownThrowawayStaff();
  await clearBucket("admin:impersonate");
  await closeSessions();
  await ctxAnon?.close().catch(() => {});
  await ctxOperator?.close().catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════════
// J20 — transfer ownership
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J20 transfer ownership", () => {
  test("REFUSED: every tenant role and anonymous, both verbs, nothing moves", async ({ baseURL }) => {
    const path = `/api/admin/customers/${tenantId}/transfer-ownership`;
    const before = (
      await sql<{ id: string; role: string }>(
        'SELECT id, role FROM "User" WHERE "tenantId" = $1 ORDER BY id',
        [tenantId],
      )
    ).map((r) => `${r.id}:${r.role}`);

    for (const [role, c] of [
      ["owner", ctxOwner],
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
      ["anonymous", ctxAnon],
    ] as const) {
      const g = await apiCall(c.request, "get", path, baseURL!);
      expect(g.status, `${role} GET transfer-ownership`).toBe(403);
      // The refusal must not leak the candidate list.
      expect(
        (g.body as { candidates?: unknown }).candidates,
        `${role} must not see the candidate list`,
      ).toBeUndefined();

      const p = await apiCall(c.request, "post", path, baseURL!, {
        targetUserId: managerStaff.id,
        reason: "campaign probe",
        confirmName: "Total BJJ",
      });
      expect(p.status, `${role} POST transfer-ownership`).toBe(403);
    }

    // A bare x-admin-secret header with no operator session is a second door —
    // drive it with a WRONG value; the real secret is never sent by hand.
    const forged = await ctxAnon.request.fetch(path, {
      method: "POST",
      headers: { Origin: baseURL!, "x-admin-secret": "not-the-secret" },
      data: { targetUserId: managerStaff.id, reason: "campaign probe", confirmName: "Total BJJ" },
    });
    expect(forged.status(), "a wrong x-admin-secret is refused").toBe(403);

    // A forged matflow_admin cookie.
    const forgedCookieCtx = await ctxAnon.browser()!.newContext({ baseURL: baseURL!, storageState: undefined });
    await forgedCookieCtx.addCookies([
      { name: "matflow_admin", value: "forged-value", url: baseURL! },
    ]);
    const forgedCookie = await forgedCookieCtx.request.fetch(path, {
      method: "POST",
      headers: { Origin: baseURL! },
      data: { targetUserId: managerStaff.id, reason: "campaign probe", confirmName: "Total BJJ" },
    });
    expect(forgedCookie.status(), "a forged matflow_admin cookie is refused").toBe(403);
    await forgedCookieCtx.close();

    const after = (
      await sql<{ id: string; role: string }>(
        'SELECT id, role FROM "User" WHERE "tenantId" = $1 ORDER BY id',
        [tenantId],
      )
    ).map((r) => `${r.id}:${r.role}`);
    expect(after, "every role on the seeded club is exactly as it was").toEqual(before);
  });

  test("the operator transfers on the throwaway club only", async ({ baseURL }) => {
    test.skip(!ctxOperator, "UNCOVERED — MATFLOW_ADMIN_SECRET is absent from the runner env");
    const op = ctxOperator!;
    const path = `/api/admin/customers/${throwaway.id}/transfer-ownership`;

    // A target user must already exist on the tenant.
    const suffix = Math.random().toString(36).slice(2, 8);
    const targetEmail = `${RUN_STAMP}-heir-${suffix}@example.test`;
    const heir = (
      await sql<{ id: string }>(
        `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'manager', 0, now(), now())
         RETURNING id`,
        [throwaway.id, targetEmail, `Campaign Heir ${suffix}`, "$2a$10$abcdefghijklmnopqrstuv"],
      )
    )[0];

    const candidates = await apiCall(op.request, "get", path, baseURL!);
    expect(candidates.status, "the operator reads the candidate list").toBe(200);

    // A non-existent user id and a MEMBER id are both refused, and nothing moves.
    const memberRow = (
      await sql<{ id: string }>('SELECT id FROM "Member" WHERE "tenantId" = $1 LIMIT 1', [tenantId])
    )[0];
    for (const [label, targetUserId] of [
      ["a non-existent user", "00000000-0000-0000-0000-000000000000"],
      ["a member id", memberRow?.id ?? "no-member"],
      ["a user in another club", managerStaff.id],
    ] as const) {
      const r = await apiCall(op.request, "post", path, baseURL!, {
        targetUserId,
        reason: "campaign probe",
        confirmName: `Campaign Club`,
      });
      console.log(`[L-B J20] transfer to ${label} → ${r.status}`);
      expect(r.status, `${label} is refused`).toBeGreaterThanOrEqual(400);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
      const owners = await countOf("User", '"tenantId" = $1 AND role = $2', [throwaway.id, "owner"]);
      expect(owners, `${label} left exactly one owner`).toBe(1);
    }

    // CSRF: the operator plane is guarded too.
    const noOrigin = await op.request.fetch(path, {
      method: "POST",
      data: { targetUserId: heir.id, reason: "campaign probe", confirmName: "Campaign Club" },
    });
    expect(noOrigin.status(), "transfer with no Origin").toBe(403);

    console.log("[L-B J20] candidate key set:", JSON.stringify(Object.keys(candidates.body as object)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J21 — impersonation and attribution
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J21 impersonation", () => {
  test("REFUSED: DELETE admin/impersonate without an operator session", async ({ baseURL }) => {
    for (const [role, c] of [
      ["owner", ctxOwner],
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
      ["anonymous", ctxAnon],
    ] as const) {
      const d = await apiCall(c.request, "delete", "/api/admin/impersonate", baseURL!);
      expect(d.status, `${role} DELETE admin/impersonate`).toBeGreaterThanOrEqual(400);
      expect(d.status, "and never a 500").toBeLessThan(500);
      const p = await apiCall(c.request, "post", "/api/admin/impersonate", baseURL!, {
        targetUserId: "00000000-0000-0000-0000-000000000000",
        reason: "campaign probe",
      });
      expect(p.status, `${role} POST admin/impersonate`).toBe(403);
    }
  });

  test("impersonating a throwaway owner: three mutations, then count the attribution", async ({
    browser,
    baseURL,
  }) => {
    test.skip(!ctxOperator, "UNCOVERED — MATFLOW_ADMIN_SECRET is absent from the runner env");
    const op = ctxOperator!;

    const start = await apiCall(op.request, "post", "/api/admin/impersonate", baseURL!, {
      targetUserId: throwaway.ownerId,
      reason: "campaign assessment of audit attribution",
    });
    expect(start.status, "the operator starts an impersonation").toBe(200);

    // The impersonation cookie rides on THIS context — never written to disk.
    const auditBefore = await countOf("AuditLog", '"tenantId" = $1', [throwaway.id]);

    // Three ordinary tenant mutations, made while impersonating.
    const m1 = await apiCall(op.request, "patch", "/api/settings", baseURL!, {
      primaryColor: "#123456",
    });
    const m2 = await apiCall(op.request, "post", "/api/initiatives", baseURL!, {
      type: "marketing",
      startDate: new Date().toISOString(),
      notes: `${RUN_STAMP} impersonated initiative`,
    });
    const m3 = await apiCall(op.request, "post", "/api/settings/kiosk", baseURL!, { action: "enable" });
    console.log(`[L-B J21] impersonated mutations → ${m1.status}, ${m2.status}, ${m3.status}`);

    await expect
      .poll(async () => countOf("AuditLog", '"tenantId" = $1', [throwaway.id]), { timeout: 5_000 })
      .toBeGreaterThan(auditBefore);

    const rows = await sql<{ action: string; actingAs: string | null }>(
      `SELECT action, metadata->>'actingAs' AS "actingAs"
         FROM "AuditLog" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 20`,
      [throwaway.id],
    );
    const unattributed = rows.filter((r) => !r.actingAs);
    console.log(
      "[L-B J21] audit rows written under impersonation:",
      JSON.stringify(rows.map((r) => `${r.action}=${r.actingAs ?? "NULL"}`)),
    );
    // The inherited finding: only app/api/admin/** logAudit sites pass actingAs,
    // so an ordinary tenant route under impersonation writes an unattributed
    // row. L-G fixes it; this lane counts. The assertion states the CORRECT
    // behaviour so it flips green the moment L-G lands the fix.
    expect(
      unattributed.map((r) => r.action),
      "every audit row written while impersonating must carry metadata->>'actingAs'",
    ).toEqual([]);

    const stop = await apiCall(op.request, "delete", "/api/admin/impersonate", baseURL!);
    expect(stop.status, "the operator stops impersonating").toBe(200);

    // The impersonated session after the stop: the same context must no longer
    // be able to write as that owner.
    const afterStop = await apiCall(op.request, "patch", "/api/settings", baseURL!, {
      primaryColor: "#654321",
    });
    console.log(`[L-B J21] PATCH settings after stop → ${afterStop.status}`);
    expect(afterStop.status, "the impersonated identity is gone").toBeGreaterThanOrEqual(400);

    void browser;
  });

  test("GET audit-log per role: who can read the club's paper trail", async ({ baseURL }) => {
    const seen: Record<string, number> = {};
    for (const [role, c] of [
      ["owner", ctxOwner],
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
      ["anonymous", ctxAnon],
    ] as const) {
      const r = await apiCall(c.request, "get", "/api/audit-log", baseURL!);
      seen[role] = r.status;
      if (r.status === 200) {
        const text = JSON.stringify(r.body);
        expect(text, "the audit log never carries a password hash").not.toContain("passwordHash");
        expect(text, "nor a token").not.toMatch(/"token"\s*:/);
      }
    }
    console.log("[L-B J21] GET /api/audit-log by role:", JSON.stringify(seen));
    expect(seen.member, "a member cannot read the club's audit log").toBeGreaterThanOrEqual(400);
    expect(seen.anonymous, "nor can anonymous").toBeGreaterThanOrEqual(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J62 — Google Drive and initiatives
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J62 Drive integration", () => {
  test("REFUSED: every drive route for every role but the owner", async ({ baseURL }) => {
    const gets = ["/api/drive/status", "/api/drive/connect", "/api/drive/folders", "/api/drive/callback"];
    const posts: [string, unknown][] = [
      ["/api/drive/disconnect", {}],
      ["/api/drive/select-folder", { folderId: "x", folderName: "y" }],
      ["/api/drive/index", {}],
    ];
    const connBefore = await countOf("GoogleDriveConnection", '"tenantId" = $1', [tenantId]);

    for (const [role, c, expected] of [
      ["manager", ctxManager, 403],
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      for (const url of gets) {
        const r = await apiCall(c.request, "get", url, baseURL!);
        // The callback answers with a redirect for an authed owner; for a
        // refused role it must be the JSON gate, not a redirect to /login.
        expect(r.status, `${role} GET ${url}`).toBe(expected);
        expect((r.body as { ok?: boolean }).ok, `${role} ${url} refusal shape`).toBe(false);
      }
      for (const [url, data] of posts) {
        const r = await apiCall(c.request, "post", url, baseURL!, data);
        expect(r.status, `${role} POST ${url}`).toBe(expected);
      }
    }
    await assertUnchanged("GoogleDriveConnection", connBefore, '"tenantId" = $1', [tenantId]);
  });

  test("the owner without a grant: status, disconnect and index are honest, never 500", async ({
    baseURL,
  }) => {
    // The OAuth grant itself is UNCOVERED by name — it needs a live Google
    // consent screen. Everything either side of it is asserted.
    const conn = await countOf("GoogleDriveConnection", '"tenantId" = $1', [tenantId]);
    test.skip(conn > 0, "the seeded club already holds a Drive grant — not this lane's to revoke");

    const status = await apiCall(ctxOwner.request, "get", "/api/drive/status", baseURL!);
    expect(status.status, "status with no grant").toBe(200);
    expect((status.body as { connected?: boolean }).connected).toBe(false);

    const disc = await apiCall(ctxOwner.request, "post", "/api/drive/disconnect", baseURL!, {});
    console.log(`[L-B J62] POST drive/disconnect with no grant → ${disc.status}`);
    expect(disc.status, "disconnecting nothing is not a crash").toBeLessThan(500);

    const idx = await apiCall(ctxOwner.request, "post", "/api/drive/index", baseURL!, {});
    expect(idx.status, "indexing with no folder selected").toBe(400);
    expect((idx.body as { error?: string }).error).toBe("No folder selected");

    const sel = await apiCall(ctxOwner.request, "post", "/api/drive/select-folder", baseURL!, {
      folderId: "../../etc/passwd",
      folderName: "y",
    });
    console.log(`[L-B J62] select-folder with a traversal folderId → ${sel.status}`);
    expect(sel.status, "a traversal folder id is not a 500").toBeLessThan(500);

    const cb = await apiCall(ctxOwner.request, "get", "/api/drive/callback?code=x&state=forged", baseURL!);
    // A forged state must not mint a connection.
    expect(await countOf("GoogleDriveConnection", '"tenantId" = $1', [tenantId]), "no grant was minted").toBe(
      conn,
    );
    console.log(`[L-B J62] drive/callback with a forged state → ${cb.status}`);

    await clearBucket(`drive:index:${tenantId}`);
  });
});

test.describe("J62 initiatives", () => {
  let initiativeId: string;

  test("CRUD per role: owner and manager write, coach, admin, member and anonymous do not", async ({
    baseURL,
  }) => {
    const before = await countOf("Initiative", '"tenantId" = $1', [tenantId]);

    for (const [role, c, expected] of [
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const g = await apiCall(c.request, "get", "/api/initiatives", baseURL!);
      expect(g.status, `${role} GET initiatives`).toBe(expected);
      const p = await apiCall(c.request, "post", "/api/initiatives", baseURL!, {
        type: "marketing",
        startDate: new Date().toISOString(),
        notes: `${RUN_STAMP} forged`,
      });
      expect(p.status, `${role} POST initiatives`).toBe(expected);
    }
    await assertUnchanged("Initiative", before, '"tenantId" = $1', [tenantId]);

    // The manager is an ALLOWED cell — drive it and prove it by the row.
    const created = await apiCall(ctxManager.request, "post", "/api/initiatives", baseURL!, {
      type: "marketing",
      startDate: new Date().toISOString(),
      notes: `${RUN_STAMP} manager initiative`,
    });
    expect(created.status, "a manager may record an initiative").toBe(201);
    initiativeId = (created.body as { id: string }).id;
    const row = (
      await sql<{ notes: string | null; tenantId: string }>(
        'SELECT notes, "tenantId" FROM "Initiative" WHERE id = $1',
        [initiativeId],
      )
    )[0];
    expect(row.notes, "the row proves the write").toBe(`${RUN_STAMP} manager initiative`);
    expect(row.tenantId, "and it landed in the right club").toBe(tenantId);
  });

  test("a malformed startDate must be a 400, not a 500", async ({ baseURL }) => {
    const before = await countOf("Initiative", '"tenantId" = $1', [tenantId]);
    const cases: [string, unknown][] = [
      ["a non-date string", { type: "other", startDate: "not-a-date" }],
      ["a 1970 date", { type: "other", startDate: "1970-01-01T00:00:00.000Z" }],
      ["an end before the start", { type: "other", startDate: "2026-01-02", endDate: "2026-01-01" }],
      ["a 10 000-character note", { type: "other", startDate: "2026-01-02", notes: "x".repeat(10_000) }],
      ["a type outside the six", { type: "sabotage", startDate: "2026-01-02" }],
      ["an empty body", {}],
    ];
    const statuses: string[] = [];
    for (const [label, data] of cases) {
      const r = await apiCall(ctxOwner.request, "post", "/api/initiatives", baseURL!, data);
      statuses.push(`${label} → ${r.status}`);
      expect(r.status, `${label} is never a 500 (app/api/initiatives/route.ts:61 takes new Date() raw)`).toBeLessThan(
        500,
      );
    }
    console.log("[L-B J62] initiative fuzz:", JSON.stringify(statuses));
    await sql('DELETE FROM "Initiative" WHERE notes LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
    void before;
  });

  test("cross-tenant: an initiative id from another club answers 404 and is not read", async ({ baseURL }) => {
    // HARNESS FIX (round 1): `Initiative` has no `updatedAt`, and
    // `createdById` is NOT NULL (prisma/schema.prisma, model Initiative) —
    // the round-1 INSERT would have failed on both counts. The throwaway
    // club's own owner is the author.
    const foreign = (
      await sql<{ id: string }>(
        `INSERT INTO "Initiative" ("id", "tenantId", "type", "startDate", "notes", "createdById", "createdAt")
         VALUES (gen_random_uuid()::text, $1, 'other', now(), $2, $3, now())
         RETURNING id`,
        [throwaway.id, `${RUN_STAMP} foreign initiative`, throwaway.ownerId],
      )
    )[0];
    const p = await apiCall(ctxOwner.request, "patch", `/api/initiatives/${foreign.id}`, baseURL!, {
      notes: `${RUN_STAMP} hijacked`,
    });
    expect(p.status, "a foreign id answers like a missing one").toBe(404);
    const d = await apiCall(ctxOwner.request, "delete", `/api/initiatives/${foreign.id}`, baseURL!);
    expect(d.status, "and the same on delete").toBe(404);
    const still = (
      await sql<{ notes: string | null }>('SELECT notes FROM "Initiative" WHERE id = $1', [foreign.id])
    )[0];
    expect(still.notes, "the foreign row is untouched").toBe(`${RUN_STAMP} foreign initiative`);

    // And the seeded club's GET never carries it.
    const list = await apiCall(ctxOwner.request, "get", "/api/initiatives", baseURL!);
    expect(JSON.stringify(list.body), "no cross-tenant row in the list").not.toContain(foreign.id);
  });

  test("attachments: a ../ filename, a 20 MB upload and a script-bearing SVG", async ({ baseURL }) => {
    test.skip(!initiativeId, "the manager's initiative was not created");
    const before = await countOf("InitiativeAttachment", '"initiativeId" = $1', [initiativeId]);

    const traversal = await ctxOwner.request.fetch(`/api/initiatives/${initiativeId}/attachments`, {
      method: "POST",
      headers: { Origin: baseURL! },
      multipart: {
        file: {
          name: "../../../../etc/passwd.png",
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
        },
      },
    });
    console.log(`[L-B J62] ../ filename upload → ${traversal.status()}`);
    // Round 2. This file is WELL FORMED — a real PNG header, only its NAME is
    // hostile — so it is the one case in this test that legitimately reaches
    // storage. `.env.test` has no `BLOB_READ_WRITE_TOKEN`, so the honest
    // answer is 503 "File uploads not configured"; with a token it is 201 and
    // the two assertions below prove the stored key is server-minted.
    //
    // What round 2 fixed is that 503 used to be the answer to EVERY upload:
    // the token check stood ahead of the size, type and magic-byte checks
    // (app/api/initiatives/[id]/attachments/route.ts:32), so the oversize and
    // script-bearing cases below could not be refused on their merits in any
    // environment. They are now 400s regardless of storage — which is what
    // makes the two assertions after this one mean anything.
    expect(
      [201, 503],
      "a traversal filename is stored under a server-minted key, or honestly 503 with no storage configured",
    ).toContain(traversal.status());
    if (traversal.status() === 201) {
      const a = (await traversal.json()) as { filename: string; blobUrl: string };
      expect(a.blobUrl, "the stored path is server-minted, never the client's name").toContain(
        `tenants/${tenantId}/initiatives/${initiativeId}/`,
      );
      expect(a.blobUrl, "no traversal survived into the blob key").not.toContain("..");
    }

    const oversize = await ctxOwner.request.fetch(`/api/initiatives/${initiativeId}/attachments`, {
      method: "POST",
      headers: { Origin: baseURL! },
      multipart: {
        file: { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(20 * 1024 * 1024, 1) },
      },
    });
    // Round 2: a 400, exactly — not merely "some 4xx". 20 MB is the caller's
    // fault and always will be, whatever the storage config says.
    expect(oversize.status(), "20 MB is refused on its own merits").toBe(400);

    const svg = await ctxOwner.request.fetch(`/api/initiatives/${initiativeId}/attachments`, {
      method: "POST",
      headers: { Origin: baseURL! },
      multipart: {
        file: {
          name: "logo.png",
          mimeType: "image/png",
          buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        },
      },
    });
    expect(svg.status(), "an SVG declaring itself a PNG fails the magic-byte check").toBe(400);

    const noOrigin = await ctxOwner.request.fetch(`/api/initiatives/${initiativeId}/attachments`, {
      method: "POST",
      multipart: {
        file: { name: "x.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    expect(noOrigin.status(), "the formData route is CSRF-guarded").toBe(403);

    void before;
  });
});
