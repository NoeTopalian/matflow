/**
 * Keep closed clubs (product rule, Noe, 16 Oct 2026) — post-restore containment.
 *
 * `scripts/readiness/backup-post-restore.mjs` used to reset every closed club's
 * `deletedAt` to the restore time so a restored copy had a fresh 30-day grace
 * before the retention cron purged it. There is no by-age purge any more, so
 * that step would only rewrite each club's real closing date (the "Closed
 * <d Mon yyyy>" badge and the `admin.tenant.soft_deleted` audit row would stop
 * agreeing) and the verifier would report a legitimately long-closed club as a
 * hazard. These cells pin that the script leaves closed clubs alone while still
 * revoking kiosk/leaderboard tokens and detaching Stripe accounts.
 *
 * A fake pg client records every statement; nothing connects.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { restoredHazards, neutralisationCheck, neutraliseRestoredCopy } from "../../scripts/readiness/backup-post-restore.mjs";

type Row = Record<string, unknown>;

/** Counts a copy that holds three closed clubs, one of them closed 400 days ago, plus one kiosk token and one Stripe account. */
function fakeClient(counts: { kiosk?: number; display?: number; stripe?: number } = {}) {
  const sql: string[] = [];
  const { kiosk = 1, display = 0, stripe = 1 } = counts;
  const client = {
    sql,
    async query(text: string, params?: unknown[]) {
      sql.push(text);
      if (/md5\(coalesce\(string_agg/.test(text)) return { rows: [{ d: "digest", n: 2 }] as Row[], rowCount: 1 };
      if (/^\s*select count\(\*\)/i.test(text)) {
        if (/"deletedAt" is not null/.test(text)) return { rows: [{ count: 3 }] as Row[], rowCount: 1 };
        if (/interval '30 days'/.test(text)) return { rows: [{ count: 1 }] as Row[], rowCount: 1 };
        if (/"kioskTokenHash" is not null/.test(text)) return { rows: [{ count: kiosk }] as Row[], rowCount: 1 };
        if (/"displayTokenHash" is not null/.test(text)) return { rows: [{ count: display }] as Row[], rowCount: 1 };
        if (/"stripeAccountId" is not null/.test(text)) return { rows: [{ count: stripe }] as Row[], rowCount: 1 };
        return { rows: [{ count: 0 }] as Row[], rowCount: 1 };
      }
      if (/^\s*update "Tenant" t set "stripeAccountId"/.test(text)) return { rows: [{ tenantId: "t1", stripeAccountId: "acct_1" }] as Row[], rowCount: 1 };
      if (/^\s*update "Tenant" set "kioskTokenHash"/.test(text)) return { rows: [] as Row[], rowCount: kiosk };
      if (/^\s*update "Tenant" set "displayTokenHash"/.test(text)) return { rows: [] as Row[], rowCount: display };
      if (/^\s*update "Tenant"/.test(text)) return { rows: [{ tenantId: "t1", deletedAt: new Date("2025-09-01T00:00:00Z"), purgeStartedAt: null }] as Row[], rowCount: 3 };
      if (/^\s*insert into "AuditLog"/.test(text)) {
        client.audit = JSON.parse(String(params?.[1] ?? "{}")) as Row;
        return { rows: [] as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
    audit: null as Row | null,
  };
  return client;
}

const SCRIPT = fs.readFileSync(path.join(process.cwd(), "scripts/readiness/backup-post-restore.mjs"), "utf8");

describe("restoredHazards: a closed club is not a hazard, however long ago it closed", () => {
  it("reports no purge-grace count and asks the database for none", async () => {
    const client = fakeClient();
    const hazards = await restoredHazards(client);
    expect(hazards).not.toHaveProperty("tenantsPastPurgeGrace");
    expect(client.sql.filter((s) => /interval '30 days'/.test(s))).toEqual([]);
  });
});

describe("neutralisationCheck: ok means no token or Stripe link would act — closed clubs do not count", () => {
  it("is ok on a copy that holds a club closed more than 30 days once tokens and Stripe are neutralised", async () => {
    const client = fakeClient({ kiosk: 0, display: 0, stripe: 0 });
    const check = await neutralisationCheck(client);
    expect(check).not.toHaveProperty("tenantsPastPurgeGrace");
    expect(check.ok).toBe(true);
    expect(client.sql.filter((s) => /interval '30 days'/.test(s))).toEqual([]);
  });

  it("is still not ok while a kiosk token or a Stripe account remains", async () => {
    expect((await neutralisationCheck(fakeClient({ kiosk: 1, display: 0, stripe: 0 }))).ok).toBe(false);
    expect((await neutralisationCheck(fakeClient({ kiosk: 0, display: 0, stripe: 1 }))).ok).toBe(false);
  });
});

describe("neutraliseRestoredCopy: never rewrites a closed club's closing date", () => {
  it("issues no update that touches deletedAt, and the audit row carries no purge clocks", async () => {
    const client = fakeClient();
    const out = await neutraliseRestoredCopy(client);
    const tenantUpdates = client.sql.filter((s) => /^\s*update "Tenant"/.test(s));
    expect(tenantUpdates.filter((s) => /"deletedAt"/.test(s))).toEqual([]);
    expect(out).not.toHaveProperty("purgeClocksReset");
    expect(client.audit).not.toBeNull();
    expect(client.audit?.originals).not.toHaveProperty("purgeClocks");
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("still revokes kiosk and leaderboard tokens and detaches Stripe accounts", async () => {
    const client = fakeClient({ kiosk: 2, display: 1, stripe: 1 });
    const out = await neutraliseRestoredCopy(client);
    expect(out).toMatchObject({ kioskTokensRevoked: 2, displayTokensRevoked: 1, stripeAccountsDetached: 1, totpSecretsKept: 2 });
    expect(client.sql.some((s) => /update "Tenant" set "kioskTokenHash" = null/.test(s))).toBe(true);
    expect(client.sql.some((s) => /update "Tenant" set "displayTokenHash" = null/.test(s))).toBe(true);
    expect(client.sql.some((s) => /update "Tenant" t set "stripeAccountId" = null/.test(s))).toBe(true);
    expect(client.audit?.originals).toMatchObject({ stripeAccounts: [{ tenantId: "t1", stripeAccountId: "acct_1" }] });
  });
});

describe("source ratchet", () => {
  it("the script carries no 30-day purge premise", () => {
    expect(SCRIPT).not.toMatch(/interval '30 days'|purgeClocksReset|tenantsPastPurgeGrace/);
  });
});
