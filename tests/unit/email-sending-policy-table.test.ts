/**
 * The sending-policy truth table (17 Oct 2026), exhaustively, through the real
 * `sendEmail` with the Resend client mocked and every provider call counted.
 *
 *   environment   local (no VERCEL_ENV) · preview · production
 *   EMAIL_DELIVERY  off · test · on · unset · an unrecognised value
 *   EMAIL_TEST_RECIPIENTS  lists the recipient · empty · invalid (one bad entry)
 *   RESEND_API_KEY  present · missing
 *   recipient     the listed address · an address not on the list
 *
 * Rule under test: Resend is called only when
 *   - the key is present, AND
 *   - EMAIL_DELIVERY=on on the Vercel production deployment (any recipient), OR
 *   - EMAIL_DELIVERY=test anywhere, or =on outside production, with a fully
 *     valid list that contains the recipient.
 * Unset and unrecognised values never send — so adding a key, paying for
 * Resend or deploying code cannot start mail by itself. The mock stands in for
 * Resend: this is simulated evidence of the code path, not of delivery.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
let seq = 0;

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: (args: unknown) => resendSendMock(args) };
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      emailLog: {
        findFirst: () => Promise.resolve(null),
        create: () => Promise.resolve({ id: `log-${++seq}` }),
        update: () => Promise.resolve({}),
      },
      tenant: { findUnique: () => Promise.resolve({ contactEmail: null, billingContactEmail: null }) },
    })),
  withRlsBypass: (fn: (tx: unknown) => unknown) => Promise.resolve(fn({ user: { findFirst: () => Promise.resolve(null) } })),
}));

const LISTED = "noe.test@example.test";
const UNLISTED = "member@example.test";
const ENVS = { local: undefined, preview: "preview", production: "production" } as const;
const MODES = { off: "off", test: "test", on: "on", unset: undefined, unrecognised: "true" } as const;
const LISTS = { present: LISTED, empty: "", invalid: `${LISTED}, Sean <sean@example.test>` } as const;
const KEYS = { present: "re_table_key", missing: undefined } as const;
const ENV_KEYS = ["VERCEL_ENV", "EMAIL_DELIVERY", "EMAIL_TEST_RECIPIENTS", "RESEND_API_KEY", "DATABASE_URL"];

const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const set = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

function expected(env: keyof typeof ENVS, mode: keyof typeof MODES, list: keyof typeof LISTS, key: keyof typeof KEYS, to: string): boolean {
  if (key === "missing") return false;
  if (mode === "on" && env === "production") return true;
  const allowlisted = mode === "test" || mode === "on";
  return allowlisted && list === "present" && to === LISTED;
}

describe("sending-policy truth table — every combination through sendEmail", () => {
  const rows: Array<[keyof typeof ENVS, keyof typeof MODES, keyof typeof LISTS, keyof typeof KEYS]> = [];
  for (const e of Object.keys(ENVS) as (keyof typeof ENVS)[])
    for (const m of Object.keys(MODES) as (keyof typeof MODES)[])
      for (const l of Object.keys(LISTS) as (keyof typeof LISTS)[])
        for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) rows.push([e, m, l, k]);

  it.each(rows)("%s · EMAIL_DELIVERY %s · list %s · key %s", async (env, mode, list, key) => {
    for (const to of [LISTED, UNLISTED]) {
      set("VERCEL_ENV", ENVS[env]);
      set("EMAIL_DELIVERY", MODES[mode]);
      set("EMAIL_TEST_RECIPIENTS", LISTS[list]);
      set("RESEND_API_KEY", KEYS[key]);
      resendSendMock.mockReset();
      resendSendMock.mockResolvedValue({ data: { id: `re_${++seq}` }, error: null });
      vi.resetModules(); // the Resend client is cached per process; rebuild it for this key state
      const { sendEmail } = await import("@/lib/email");
      const r = await sendEmail({ tenantId: "t1", templateId: "test", to, vars: {} });
      const want = expected(env, mode, list, key, to);
      expect(resendSendMock.mock.calls.length, `provider calls for ${to}`).toBe(want ? 1 : 0);
      expect(r.ok, `ok for ${to}`).toBe(want);
      if (want) expect((resendSendMock.mock.calls[0][0] as { to: string }).to).toBe(to);
    }
  });

  it("the production database alone never opens sending (local server on the production .env)", async () => {
    set("DATABASE_URL", "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.example/db");
    set("EMAIL_DELIVERY", "on");
    set("RESEND_API_KEY", "re_table_key");
    resendSendMock.mockReset();
    vi.resetModules();
    const { sendEmail } = await import("@/lib/email");
    const r = await sendEmail({ tenantId: "t1", templateId: "test", to: UNLISTED, vars: {} });
    expect(r.suppressed).toBe("recipient_not_allowlisted");
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});
