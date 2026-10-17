/**
 * Resend webhook handler (17 Oct 2026). SIMULATED provider evidence: requests
 * are signed with the real `svix` library and a throwaway test secret (the
 * same scheme Resend uses), and EmailLog is an in-memory store with the same
 * conditional-update semantics as the database. No network, no Resend.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { Webhook } from "svix";
import { randomBytes } from "node:crypto";

type Row = { id: string; resendId: string; recipient: string; status: string; errorMessage: string | null };
const store = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  fail: false,
  writes: 0,
  /** Runs once just before the next conditional update: simulates another delivery landing between read and write. */
  interleave: null as null | (() => void),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async (fn: (tx: unknown) => unknown) => {
    if (store.fail) throw new Error("connection terminated");
    return fn({
      emailLog: {
        findUnique: async ({ where }: { where: { resendId: string } }) => {
          const r = [...store.rows.values()].find((x) => x.resendId === where.resendId);
          return r ? { id: r.id, status: r.status, recipient: r.recipient } : null;
        },
        // Unconditional update (the pre-17-Oct route used it); kept so the same
        // tests can be run against older code as a red check.
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const r = store.rows.get(where.id);
          if (r) { Object.assign(r, data); store.writes++; }
          return r;
        },
        updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<Row> }) => {
          const between = store.interleave;
          store.interleave = null;
          between?.();
          const r = store.rows.get(where.id);
          if (!r || r.status !== where.status) return { count: 0 };
          Object.assign(r, data);
          store.writes++;
          return { count: 1 };
        },
      },
    });
  },
}));

const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const signer = new Webhook(SECRET);
let seq = 0;

function signed(body: unknown, opts: { id?: string; at?: Date; secret?: string; raw?: string } = {}): Request {
  const payload = opts.raw ?? JSON.stringify(body);
  const id = opts.id ?? `msg_${++seq}`;
  const at = opts.at ?? new Date();
  const signature = (opts.secret ? new Webhook(opts.secret) : signer).sign(id, at, payload);
  return new Request("http://localhost/api/webhooks/resend", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": signature, "content-type": "application/json" },
    body: payload,
  });
}
const ev = (type: string, emailId = "re_1", extra: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: ["tester@example.test"], ...extra } });
const row = () => store.rows.get("log-1")!;

async function post(req: Request) {
  const { POST } = await import("@/app/api/webhooks/resend/route");
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as { outcome: string } };
}

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  store.fail = false;
  store.writes = 0;
  store.interleave = null;
  store.rows = new Map([["log-1", { id: "log-1", resendId: "re_1", recipient: "Tester@Example.test", status: "sent", errorMessage: null }]]);
});

describe("signature (svix, raw body)", () => {
  it("a valid signature is processed", async () => {
    const r = await post(signed(ev("email.delivered")));
    expect(r).toEqual({ status: 200, body: expect.objectContaining({ outcome: "applied" }) });
    expect(row().status).toBe("delivered");
  });

  it("a signature made with another secret is rejected and nothing is read or written", async () => {
    const r = await post(signed(ev("email.delivered"), { secret: `whsec_${randomBytes(24).toString("base64")}` }));
    expect(r.status).toBe(401);
    expect(row().status).toBe("sent");
  });

  it("missing signature headers are rejected", async () => {
    const res = await (await import("@/app/api/webhooks/resend/route")).POST(
      new Request("http://localhost/api/webhooks/resend", { method: "POST", body: JSON.stringify(ev("email.delivered")) }),
    );
    expect(res.status).toBe(401);
    expect(store.writes).toBe(0);
  });

  it("a stale signature (older than Svix's 5-minute tolerance) is rejected", async () => {
    const r = await post(signed(ev("email.delivered"), { at: new Date(Date.now() - 10 * 60 * 1000) }));
    expect(r.status).toBe(401);
    expect(store.writes).toBe(0);
  });

  it("a body changed after signing is rejected (verification is on the raw body)", async () => {
    const good = signed(ev("email.delivered"));
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify(ev("email.complained")) });
    expect((await post(tampered)).status).toBe(401);
    expect(row().status).toBe("sent");
  });

  it("no RESEND_WEBHOOK_SECRET → 503 in every environment, nothing processed", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    for (const env of ["development", "test", "production"]) {
      (process.env as Record<string, string>).NODE_ENV = env;
      const r = await post(signed(ev("email.delivered")));
      expect(r.status).toBe(503);
    }
    (process.env as Record<string, string>).NODE_ENV = "test";
    expect(store.writes).toBe(0);
  });

  it("a secret that is not a full Svix secret → 503 (set-up fault), not 401, nothing processed", async () => {
    // svix itself accepts "whsec_" and "abcd", and a signature made with that weak key verifies.
    for (const weak of ["whsec_%%%not-base64%%%", "whsec_", "abcd", `whsec_${randomBytes(8).toString("base64")}`]) {
      process.env.RESEND_WEBHOOK_SECRET = weak;
      const forged = weak.startsWith("whsec_%") ? signed(ev("email.delivered")) : signed(ev("email.delivered"), { secret: weak });
      const r = await post(forged);
      expect(r, weak).toEqual({ status: 503, body: expect.objectContaining({ outcome: "misconfigured_secret" }) });
    }
    expect(store.writes).toBe(0);
  });

  it("a body larger than 256 KB is refused before it is read", async () => {
    const big = new Request("http://localhost/api/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(300 * 1024) },
      body: "{}",
    });
    const res = await (await import("@/app/api/webhooks/resend/route")).POST(big);
    expect(res.status).toBe(413);
    expect(store.writes).toBe(0);
  });
});

describe("duplicates, ordering and association", () => {
  it("the same delivery twice (Resend retry, same svix-id) writes once", async () => {
    const body = ev("email.delivered");
    expect((await post(signed(body, { id: "msg_dup" }))).body.outcome).toBe("applied");
    expect((await post(signed(body, { id: "msg_dup" }))).body.outcome).toBe("duplicate");
    expect(store.writes).toBe(1);
  });

  it("delivery_delayed arriving after delivered does not overwrite it", async () => {
    await post(signed(ev("email.delivered")));
    const r = await post(signed(ev("email.delivery_delayed")));
    expect(r.body.outcome).toBe("ignored_would_downgrade");
    expect(row().status).toBe("delivered");
  });

  it("delivered arriving after bounced does not overwrite the bounce", async () => {
    await post(signed(ev("email.bounced", "re_1", { bounce: { type: "Permanent", subType: "General", message: "550 user unknown <tester@example.test>" } })));
    await post(signed(ev("email.delivered")));
    expect(row().status).toBe("bounced");
    expect(row().errorMessage).toBe("Permanent — General — 550 user unknown <[address]>");
  });

  it("delivery_delayed can move a sent email on, and delivered then supersedes it", async () => {
    await post(signed(ev("email.delivery_delayed")));
    expect(row().status).toBe("delivery_delayed");
    await post(signed(ev("email.delivered")));
    expect(row().status).toBe("delivered");
  });

  it("email.suppressed is recorded as bounced (so later sends short-circuit) with the reason", async () => {
    await post(signed(ev("email.suppressed")));
    expect(row()).toMatchObject({ status: "bounced", errorMessage: expect.stringContaining("suppression list") });
  });

  it("delivered clears the delay note left by delivery_delayed", async () => {
    await post(signed(ev("email.delivery_delayed")));
    expect(row().errorMessage).toMatch(/delayed/);
    await post(signed(ev("email.delivered")));
    expect(row()).toMatchObject({ status: "delivered", errorMessage: null });
  });

  it("a bounce landing between this event's read and write wins: delivered re-reads and does not overwrite it", async () => {
    store.interleave = () => { Object.assign(row(), { status: "bounced", errorMessage: "bounced" }); };
    const r = await post(signed(ev("email.delivered")));
    expect(r.body.outcome).toBe("ignored_would_downgrade");
    expect(row().status).toBe("bounced");
  });

  it("a delay landing between read and write: delivered re-reads and still applies once", async () => {
    store.interleave = () => { row().status = "delivery_delayed"; };
    const r = await post(signed(ev("email.delivered")));
    expect(r.body.outcome).toBe("applied");
    expect(row().status).toBe("delivered");
    expect(store.writes).toBe(1);
  });

  it("an old event for an email this database never sent is acknowledged and changes nothing", async () => {
    const old = { ...ev("email.delivered", "re_from_another_environment"), created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const r = await post(signed(old));
    expect(r).toEqual({ status: 200, body: expect.objectContaining({ outcome: "ignored_unknown_email" }) });
    expect(store.writes).toBe(0);
  });

  it("an unknown email with no usable created_at is acknowledged (cannot be judged recent)", async () => {
    for (const created_at of [undefined, "not-a-date"]) {
      const body: Record<string, unknown> = { ...ev("email.delivered", "re_unknown") };
      if (created_at === undefined) delete body.created_at; else body.created_at = created_at;
      const r = await post(signed(body));
      expect(r).toEqual({ status: 200, body: expect.objectContaining({ outcome: "ignored_unknown_email" }) });
    }
  });

  it("a recent event that beats sendEmail's resendId write answers 409 so Resend retries; the retry applies", async () => {
    store.rows.get("log-1")!.resendId = "pending"; // sendEmail has not recorded the id yet
    const body = ev("email.delivered", "re_fast");
    const first = await post(signed(body, { id: "msg_fast" }));
    expect(first).toEqual({ status: 409, body: expect.objectContaining({ outcome: "retry_unknown_recent" }) });
    expect(store.writes).toBe(0);
    store.rows.get("log-1")!.resendId = "re_fast"; // the write lands
    const retry = await post(signed(body, { id: "msg_fast" }));
    expect(retry.body.outcome).toBe("applied");
    expect(row().status).toBe("delivered");
  });

  it("an event naming a different recipient does not update the row", async () => {
    const r = await post(signed(ev("email.delivered", "re_1", { to: ["someone-else@example.test"] })));
    expect(r.body.outcome).toBe("ignored_recipient_mismatch");
    expect(row().status).toBe("sent");
  });

  it("opened / clicked / received events are acknowledged and ignored", async () => {
    for (const t of ["email.opened", "email.clicked", "email.received", "domain.updated"]) {
      expect((await post(signed(ev(t)))).body.outcome).toBe("ignored_type");
    }
    expect(store.writes).toBe(0);
  });

  it("a database failure answers 500 so Resend retries; the retry then applies once", async () => {
    store.fail = true;
    const body = ev("email.delivered");
    expect((await post(signed(body, { id: "msg_retry" }))).status).toBe(500);
    store.fail = false;
    expect((await post(signed(body, { id: "msg_retry" }))).body.outcome).toBe("applied");
    expect(store.writes).toBe(1);
  });

  it("logs never contain the recipient address, the secret or the body", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await post(signed(ev("email.bounced", "re_1", { bounce: { message: "550 tester@example.test unknown" } })));
    store.fail = true;
    await post(signed(ev("email.complained")));
    store.fail = false;
    // Headers cannot carry a newline, but spaces and "=" could forge fields on the line.
    await post(signed(ev("email.delivered"), { id: "msg_x outcome=applied email=forged" }));
    const logged = [...spy.mock.calls, ...err.mock.calls].flat().join("\n");
    expect(logged).not.toMatch(/tester@example\.test|whsec_|550/i);
    expect(logged, "a request-supplied id cannot add fields to the log line").not.toMatch(/email=forged/);
    spy.mockRestore();
    err.mockRestore();
  });
});
