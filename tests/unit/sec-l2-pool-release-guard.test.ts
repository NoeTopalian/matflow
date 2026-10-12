/**
 * R10-2 (lane L2 phase 2, 12 Oct 2026) — the pool release guard in lib/prisma.ts (guardPoolRelease, from lane L1's
 * patch 0001). It relies on two pg internals, so this file pins the installed versions and exercises both against the
 * REAL pg 8.20.0 Client and pg-pool 3.13.0 Pool, talking the Postgres wire protocol to a tiny local stub server
 * (127.0.0.1, ephemeral port; no database). The stub answers BEGIN with ReadyForQuery 'T', a failing statement with
 * ErrorResponse + 'E', COMMIT/ROLLBACK/anything else with 'I' — exactly the transaction status a server reports.
 *
 * Property: a client released while the server says it is inside a transaction ('T' or 'E') is ENDED (the connection
 * closes, so a real server rolls the transaction back) and dropped by the pool, never idled for the next caller; a
 * client released idle ('I') is kept. The next checkout after a guarded release gets a fresh connection.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { guardPoolRelease } from "@/lib/prisma";

// The INSTALLED versions, read from disk (pg-pool's "exports" does not expose package.json).
const installed = (name: string) => (JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")) as { version: string }).version;

// ── minimal Postgres protocol stub ───────────────────────────────────────────────────────────────────────────────
type Conn = { id: number; socket: net.Socket; status: "I" | "T" | "E"; terminated: boolean; closed: boolean; queries: string[] };
const conns: Conn[] = [];
let server: net.Server;
let port = 0;

function msg(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type, "ascii"), len, body]);
}
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s: string) => Buffer.from(s + "\0", "utf8");
const readyForQuery = (c: Conn) => msg("Z", Buffer.from(c.status, "ascii"));

function handle(c: Conn, sql: string) {
  c.queries.push(sql);
  const s = sql.trim().toUpperCase();
  if (s === "BEGIN") {
    c.status = "T";
    c.socket.write(Buffer.concat([msg("C", cstr("BEGIN")), readyForQuery(c)]));
  } else if (s === "COMMIT" || s === "ROLLBACK") {
    c.status = "I";
    c.socket.write(Buffer.concat([msg("C", cstr(s)), readyForQuery(c)]));
  } else if (s.startsWith("FAIL")) {
    if (c.status === "T") c.status = "E";
    const fields = Buffer.concat([Buffer.from("S"), cstr("ERROR"), Buffer.from("C"), cstr("22012"), Buffer.from("M"), cstr("division by zero"), Buffer.from([0])]);
    c.socket.write(Buffer.concat([msg("E", fields), readyForQuery(c)]));
  } else {
    // any other simple query: an empty result
    c.socket.write(Buffer.concat([msg("I", Buffer.alloc(0)), readyForQuery(c)]));
  }
}

beforeAll(async () => {
  server = net.createServer((socket) => {
    const c: Conn = { id: conns.length + 1, socket, status: "I", terminated: false, closed: false, queries: [] };
    conns.push(c);
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on("close", () => { c.closed = true; });
    socket.on("error", () => {});
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) {
          if (buf.length < 4) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          buf = buf.subarray(len);
          started = true;
          // AuthenticationOk, BackendKeyData, ReadyForQuery(I)
          socket.write(Buffer.concat([msg("R", int32(0)), msg("K", Buffer.concat([int32(1000 + c.id), int32(42)])), readyForQuery(c)]));
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) return;
        const body = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        if (type === "Q") handle(c, body.subarray(0, body.length - 1).toString("utf8"));
        else if (type === "X") { c.terminated = true; socket.end(); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  for (const c of conns) c.socket.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

let logs: string[] = [];
let pool: pg.Pool;
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  pool = guardPoolRelease(new pg.Pool({ host: "127.0.0.1", port, user: "u", database: "d", max: 1, ssl: false }));
  pool.on("error", () => {});
});
afterEach(async () => {
  await pool.end().catch(() => {});
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2_000) {
  for (let i = 0; i < ms / 20 && !cond(); i++) await sleep(20);
}

describe("versions the guard relies on are pinned", () => {
  it("installed pg is 8.20.0 and pg-pool is 3.13.0; package.json pins both exactly", () => {
    expect(installed("pg")).toBe("8.20.0");
    expect(installed("pg-pool")).toBe("3.13.0");
    // one copy of each: no nested pg-pool under pg, no nested pg under the adapter
    expect(existsSync("node_modules/pg/node_modules/pg-pool")).toBe(false);
    expect(existsSync("node_modules/@prisma/adapter-pg/node_modules/pg")).toBe(false);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; overrides: Record<string, string> };
    expect(pkg.dependencies.pg).toBe("8.20.0");
    expect(pkg.overrides["pg-pool"]).toBe("3.13.0");
  });
});

describe("R10-2: a client released inside a transaction is ended, not idled", () => {
  for (const [status, statements] of [
    ["T", ["BEGIN", "SELECT 1"]],
    ["E", ["BEGIN", "FAIL"]],
  ] as const) {
    it(`status ${status}: released → connection closed (Terminate sent), dropped by the pool, logged once; the next checkout is a fresh, idle connection`, async () => {
      const before = conns.length;
      const client = await pool.connect();
      for (const s of statements) await client.query(s).catch(() => null);
      const served = conns[conns.length - 1];
      expect(served.status).toBe(status);
      client.release(); // as adapter-pg 7.4.2 does after an abandoned start: no ROLLBACK, no error
      await until(() => served.closed);
      expect(served.closed, "the guard ended the client").toBe(true);
      expect(served.terminated, "pg sent Terminate (a clean end, so a real server rolls back)").toBe(true);
      expect(served.queries).not.toContain("ROLLBACK");
      await until(() => pool.totalCount === 0);
      expect(pool.totalCount).toBe(0);
      expect(pool.idleCount).toBe(0);
      expect(logs.filter((l) => l.includes(`released inside a transaction (status=${status})`))).toHaveLength(1);
      // the next caller gets a NEW connection, not the one left inside a transaction
      const next = await pool.connect();
      await next.query("SELECT 1");
      expect(conns.length).toBe(before + 2);
      expect(conns[conns.length - 1].status).toBe("I");
      next.release();
    });
  }

  it("status I: a client released idle (after COMMIT) is kept and reused; nothing logged", async () => {
    const before = conns.length;
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("COMMIT");
    client.release();
    await sleep(100);
    expect(pool.idleCount).toBe(1);
    expect(pool.totalCount).toBe(1);
    const again = await pool.connect();
    await again.query("SELECT 1");
    again.release();
    expect(conns.length, "the same connection was reused").toBe(before + 1);
    expect(conns[conns.length - 1].closed).toBe(false);
    expect(logs).toEqual([]);
  });

  it("a client released WITH an error is left to the pool (removed once, no second end, nothing logged by the guard)", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    const served = conns[conns.length - 1];
    client.release(new Error("caller says this client is broken"));
    await until(() => served.closed);
    expect(served.closed).toBe(true);
    expect(pool.totalCount).toBe(0);
    expect(logs.filter((l) => l.includes("released inside a transaction"))).toEqual([]);
  });

  it("mutant control: WITHOUT the guard, the same release idles the client inside its transaction (the SF-136 defect)", async () => {
    const bare = new pg.Pool({ host: "127.0.0.1", port, user: "u", database: "d", max: 1, ssl: false });
    bare.on("error", () => {});
    try {
      const client = await bare.connect();
      await client.query("BEGIN");
      const served = conns[conns.length - 1];
      client.release();
      await sleep(100);
      expect(bare.idleCount).toBe(1);
      expect(served.closed).toBe(false);
      expect(served.status, "the next caller would inherit an open transaction").toBe("T");
    } finally {
      await bare.end().catch(() => {});
    }
  });
});
