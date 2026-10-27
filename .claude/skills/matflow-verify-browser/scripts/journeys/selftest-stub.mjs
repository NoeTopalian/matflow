// Harness self-test journey: no browser and no server. It joins the journey lock like any journey (through lib.mjs),
// checks the run's fixture is in the database, then waits STUB_SECONDS (default 2), printing a heartbeat, so a
// demonstration can kill it, or its runner, mid-journey. Run through run-journeys.mjs --no-server selftest-stub.
// STUB_HELPER=1 also starts a DETACHED helper process recorded on the run (it stands in for the detached app server
// or anything else that outlives its parent), so a demonstration can show a survivor being killed by tree.
import { spawn } from "node:child_process";
import { RUN, state, q, ledger } from "../lib.mjs";
import { recordChild } from "../harness.mjs";

const L = ledger("selftest-stub");
const club = state.club;
if (!club) { L.check("fixture", "S1 the run has a fixture", false, { runId: RUN.runId }); process.exit(1); }
const rows = await q(`select id, slug from "Tenant" where id = $1`, [club.tenantId]);
L.check("fixture", "S1 the run's fixture tenant exists with the recorded slug", rows.length === 1 && rows[0].slug === club.slug, { runId: RUN.runId, slug: club.slug, participant: RUN.participant });
L.check("fixture", "S2 the slug embeds the run id", club.slug.startsWith(`mfv-${RUN.runId}-`), club.slug);
if (process.env.STUB_HELPER === "1") {
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { detached: true, stdio: "ignore", windowsHide: true });
  helper.unref();
  const rec = recordChild(RUN.runId, helper.pid, "stub-helper");
  console.log(`stub helper pid ${helper.pid} recorded (start ${rec?.start})`);
}
const seconds = Number(process.env.STUB_SECONDS ?? 2);
for (let i = 1; i <= seconds; i++) {
  console.log(`stub heartbeat ${i}/${seconds} pid ${process.pid}`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(L.summary());
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
