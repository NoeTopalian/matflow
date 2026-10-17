// Recipient allowlist + Resend webhook against REAL EmailLog rows (17 Oct 2026).
//
// Disposable club on the Neon TEST branch (tests/setup-test-db.ts refuses the
// production endpoint). Runs the real sendEmail (allowlist, EmailLog writes)
// and the real webhook route (Svix verification on the raw body, conditional
// updates) against Postgres. Stubbed: the Resend client only — each send is
// counted and answered with a unique id. SIMULATED provider; REAL persistence.
// Skips without a DB.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Webhook } from "svix";

const provider = vi.hoisted(() => ({ calls: [] as Array<{ to: string }>, seq: 0 }));
vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = {
      send: async (args: { to: string }) => {
        provider.calls.push(args);
        return { data: { id: `re-int-${Date.now()}-${++provider.seq}-${randomBytes(4).toString("hex")}` }, error: null };
      },
    };
  },
}));

import { withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const SLUG = `rwh-${STAMP}`;
const LISTED = `listed-${STAMP}@rwh.test`;
const UNLISTED = `unlisted-${STAMP}@rwh.test`;
const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const ENV_KEYS = ["EMAIL_DELIVERY", "EMAIL_TEST_RECIPIENTS", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "VERCEL_ENV"];

describe.skipIf(!HAS_DB)("allowlist + Resend webhook on real EmailLog rows", () => {
  let tenantId = "";
  const saved: Record<string, string | undefined> = {};

  const send = async (to: string) => {
    const { sendEmail } = await import("@/lib/email");
    return sendEmail({ tenantId, templateId: "test", to, vars: {} });
  };
  const row = (id: string) =>
    withRlsBypass((tx) => tx.emailLog.findUnique({ where: { id }, select: { status: true, resendId: true, errorMessage: true } }));
  const hook = async (type: string, emailId: string, opts: { id?: string; to?: string; createdAt?: string } = {}) => {
    const body = JSON.stringify({ type, created_at: opts.createdAt ?? new Date().toISOString(), data: { email_id: emailId, to: [opts.to ?? LISTED] } });
    const id = opts.id ?? `msg_${randomBytes(6).toString("hex")}`;
    const at = new Date();
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(new Request("http://localhost/api/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(SECRET).sign(id, at, body) },
      body,
    }));
    return { status: res.status, outcome: ((await res.json()) as { outcome: string }).outcome };
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.VERCEL_ENV;
    process.env.EMAIL_DELIVERY = "test";
    process.env.EMAIL_TEST_RECIPIENTS = LISTED;
    process.env.RESEND_API_KEY = "re_int_dummy_mocked";
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    tenantId = await withRlsBypass(async (tx) => (await tx.tenant.create({ data: { name: `RWH ${STAMP}`, slug: SLUG } })).id);
  });

  afterAll(async () => {
    if (tenantId) {
      await withRlsBypass(async (tx) => {
        await tx.emailLog.deleteMany({ where: { tenantId } });
        await tx.tenant.deleteMany({ where: { id: tenantId } });
      });
    }
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it("an unlisted recipient: EmailLog suppressed, no Resend id, the provider never called", async () => {
    const before = provider.calls.length;
    const r = await send(UNLISTED);
    expect(r.suppressed).toBe("recipient_not_allowlisted");
    expect(provider.calls.length).toBe(before);
    const saved = await row(r.logId);
    expect(saved?.status).toBe("suppressed");
    expect(saved?.resendId).toBeNull();
    expect(saved?.errorMessage).toMatch(/^suppressed_not_allowlisted/);
  });

  it("the listed recipient, then signed webhooks: delivered, duplicate, out of order, wrong recipient", async () => {
    const r = await send(LISTED);
    expect(r.ok).toBe(true);
    expect(provider.calls.at(-1)?.to).toBe(LISTED);
    const sent = await row(r.logId);
    expect(sent?.status).toBe("sent");
    const emailId = sent!.resendId!;
    expect(emailId).toMatch(/^re-int-/);

    expect(await hook("email.delivered", emailId, { id: "msg_int_dup" })).toEqual({ status: 200, outcome: "applied" });
    expect((await row(r.logId))?.status).toBe("delivered");
    expect(await hook("email.delivered", emailId, { id: "msg_int_dup" })).toEqual({ status: 200, outcome: "duplicate" });
    expect(await hook("email.delivery_delayed", emailId)).toEqual({ status: 200, outcome: "ignored_would_downgrade" });
    expect(await hook("email.bounced", emailId, { to: UNLISTED })).toEqual({ status: 200, outcome: "ignored_recipient_mismatch" });
    expect((await row(r.logId))?.status).toBe("delivered");
  });

  it("concurrent events for one email: the highest-ranked status always wins", async () => {
    // A fresh address per round: a complaint makes sendEmail refuse that address afterwards.
    const rounds = [0, 1, 2].map((n) => `race-${n}-${STAMP}@rwh.test`);
    process.env.EMAIL_TEST_RECIPIENTS = [LISTED, ...rounds].join(",");
    try {
      for (const [round, to] of rounds.entries()) {
        const r = await send(to);
        const emailId = (await row(r.logId))!.resendId!;
        expect(emailId, `round ${round} sent`).toMatch(/^re-int-/);
        const results = await Promise.all([
          hook("email.delivered", emailId, { to }),
          hook("email.complained", emailId, { to }),
          hook("email.delivery_delayed", emailId, { to }),
          hook("email.bounced", emailId, { to }),
        ]);
        expect(results.every((x) => x.status === 200), JSON.stringify(results)).toBe(true);
        expect((await row(r.logId))?.status, `round ${round}`).toBe("complained");
      }
    } finally {
      process.env.EMAIL_TEST_RECIPIENTS = LISTED;
    }
  });

  it("an unknown email id: recent → 409 (Resend retries), old → 200 ignored; nothing written", async () => {
    const count = () => withRlsBypass((tx) => tx.emailLog.count({ where: { tenantId } }));
    const before = await count();
    expect(await hook("email.delivered", `re-int-unknown-${STAMP}`)).toEqual({ status: 409, outcome: "retry_unknown_recent" });
    expect(await hook("email.delivered", `re-int-unknown-${STAMP}`, { createdAt: new Date(Date.now() - 3600_000).toISOString() }))
      .toEqual({ status: 200, outcome: "ignored_unknown_email" });
    expect(await count()).toBe(before);
  });

  it("after a real bounce, the next send to that address is refused without calling the provider", async () => {
    const BOUNCER = `bouncer-${STAMP}@rwh.test`;
    process.env.EMAIL_TEST_RECIPIENTS = `${LISTED},${BOUNCER}`;
    try {
      const first = await send(BOUNCER);
      const emailId = (await row(first.logId))!.resendId!;
      expect((await hook("email.bounced", emailId, { to: BOUNCER })).outcome).toBe("applied");
      const before = provider.calls.length;
      const second = await send(BOUNCER);
      expect(second.ok).toBe(false);
      expect(provider.calls.length).toBe(before);
      expect((await row(second.logId))?.status).toBe("failed");
    } finally {
      process.env.EMAIL_TEST_RECIPIENTS = LISTED;
    }
  });
});
