// SF-135 (lane L1, 11 Oct 2026): read-only observation of the server-side timeouts that could end a pooled connection
// (SHOW only; nothing is set). TEST branch only through the guarded runners.
import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";

const ON_TEST = (process.env.DATABASE_URL ?? "").includes("ep-hidden-salad");
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const NAMES = [
  "server_version",
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "idle_session_timeout",
  "transaction_timeout",
  "tcp_keepalives_idle",
];

describe.skipIf(!ON_TEST)(`L1 server settings (${ROLE})`, () => {
  it("prints the timeouts this role runs under", async () => {
    const out: Record<string, string> = {};
    for (const n of NAMES) {
      const r = await prisma.$queryRawUnsafe<{ setting: string }[]>(
        `SELECT coalesce(current_setting($1, true), 'n/a') AS setting`,
        n,
      );
      out[n] = r[0]?.setting ?? "n/a";
    }
    const line = `L1-SETTINGS ${JSON.stringify({ role: ROLE, ...out })}`;
    console.log(line);
    if (process.env.L1_EVIDENCE_OUT) appendFileSync(process.env.L1_EVIDENCE_OUT, line + "\n");
    expect(out.server_version).not.toBe("n/a");
  });
});
