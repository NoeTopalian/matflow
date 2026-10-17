// Production build and server of a MatFlow worktree against the Neon TEST branch. Run from the worktree root.
//   node server.mjs build     `next build` with no database URL in its environment (never `npm run build`, whose
//                             scripts/maybe-migrate.mjs migrates whatever database URL the shell holds)
//   node server.mjs start     next start on 127.0.0.1:MF_PORT + HTTPS proxy on localhost:MF_PORT+2, detached
//   node server.mjs stop      stops both
//   node server.mjs status    HTTP status of /api/health through the proxy
// On Windows run builds from PowerShell: Turbopack under the Bash tool fails with 0xc0000142.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP, OUT, DATA, PORT, PUB, BASE, appEnv, buildEnv, assertWorktree, node24 } from "./env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PIDS = `${OUT}/pids-${PORT}.json`;
const TLS = `${DATA}/tls`;
const git = (...args) => spawnSync("git", args, { cwd: APP, encoding: "utf8" }).stdout.trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});
async function health(timeoutMs = 10000) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(timeoutMs) }).then((x) => x.status, (e) => `down (${e.cause?.code ?? e.name})`);
}

/** A self-signed localhost certificate, made once per machine with openssl (Git for Windows ships one). */
function ensureCert() {
  const cert = `${TLS}/cert.pem`, key = `${TLS}/key.pem`;
  if (fs.existsSync(cert) && fs.existsSync(key) && new Date(new X509Certificate(fs.readFileSync(cert)).validTo) > new Date(Date.now() + 86400000)) return;
  fs.mkdirSync(TLS, { recursive: true });
  const gitExec = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const bundled = gitExec ? path.resolve(gitExec, "../../../usr/bin/openssl.exe") : null;
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "825", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"];
  for (const bin of ["openssl", bundled].filter(Boolean)) {
    if (spawnSync(bin, args, { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).status === 0) return;
  }
  throw new Error("BLOCKED: openssl not found (install Git for Windows or put openssl on PATH) — needed once to make the localhost certificate");
}

const STAMP = `${APP}/.next/matflow-verify-build.json`;
const kill = (pid) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(pid); } catch {}
};

const [cmd] = process.argv.slice(2);
if (cmd === "build") {
  assertWorktree();
  const commit = git("rev-parse", "HEAD"), dirty = !!git("status", "--porcelain");
  const r = spawnSync(node24(), ["node_modules/next/dist/bin/next", "build"], { cwd: APP, env: buildEnv(), stdio: "inherit" });
  if (r.status === 0) fs.writeFileSync(STAMP, JSON.stringify({ commit, dirty, at: new Date().toISOString() }));
  console.log(`BUILD EXIT ${r.status} commit ${commit} tree ${dirty ? "DIRTY" : "clean"}`);
  process.exit(r.status ?? 1);
} else if (cmd === "start") {
  assertWorktree();
  if (!fs.existsSync(`${APP}/.next/BUILD_ID`)) throw new Error("no production build — run: node server.mjs build");
  // The build must be of the commit being verified, or the evidence would be credited to the wrong commit.
  const built = fs.existsSync(STAMP) ? JSON.parse(fs.readFileSync(STAMP, "utf8")) : null;
  const head = git("rev-parse", "HEAD"), dirtyNow = !!git("status", "--porcelain");
  const stale = !built ? "the build was not made by server.mjs build" : built.commit !== head ? `the build is of ${built.commit.slice(0, 8)}, HEAD is ${head.slice(0, 8)}` : built.dirty || dirtyNow ? "the tree was dirty at build time or is dirty now" : null;
  if (stale && process.env.MF_ALLOW_STALE_BUILD !== "1") throw new Error(`refusing: ${stale} — run: node server.mjs build (or set MF_ALLOW_STALE_BUILD=1 and report it)`);
  if (stale) console.log(`WARNING serving a build that is not of a clean HEAD: ${stale}`);
  ensureCert();
  const env = appEnv();
  env.NEXTAUTH_URL = env.AUTH_URL = BASE;
  env.AUTH_TRUST_HOST = "true";
  const launch = (args, cwd, log, e) => {
    const out = fs.openSync(`${OUT}/${log}`, "w");
    const child = spawn(node24(), args, { cwd, env: e, stdio: ["ignore", out, out], detached: true, windowsHide: true });
    child.unref();
    return child.pid;
  };
  for (const p of [PORT, PUB]) if (await listening(p)) throw new Error(`refusing: port ${p} is already in use — stop that server or set MF_PORT`);
  const server = launch(["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(PORT)], APP, `server-${PORT}.log`, env);
  const proxy = launch([`${HERE}/tls-proxy.mjs`, String(PORT), String(PUB), TLS], HERE, `proxy-${PORT}.log`, { ...process.env });
  const builtCommit = built?.commit ?? "unknown";
  fs.writeFileSync(PIDS, JSON.stringify({ server, proxy, app: APP, build: builtCommit }));
  const fail = (msg) => { kill(server); kill(proxy); fs.rmSync(PIDS, { force: true }); throw new Error(`${msg} — both processes stopped; see ${OUT}/server-${PORT}.log and proxy-${PORT}.log`); };
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    for (const [name, pid] of [["server", server], ["proxy", proxy]]) if (!alive(pid)) fail(`${name} exited`);
    if ((await health(Math.max(1000, Math.min(10000, deadline - Date.now())))) === 200) {
      console.log(`started ${APP}, build of ${builtCommit.slice(0, 8)}: server pid ${server} (127.0.0.1:${PORT}), proxy pid ${proxy} (${BASE}); health 200; logs in ${OUT}`);
      process.exit(0);
    }
  }
  fail("no health 200 within 120 s");
} else if (cmd === "stop") {
  const p = fs.existsSync(PIDS) ? JSON.parse(fs.readFileSync(PIDS, "utf8")) : {};
  for (const pid of [p.server, p.proxy].filter(Boolean)) kill(pid);
  fs.rmSync(PIDS, { force: true });
  console.log("stopped");
} else if (cmd === "status") {
  const p = fs.existsSync(PIDS) ? JSON.parse(fs.readFileSync(PIDS, "utf8")) : null;
  const who = p ? `${p.app}, build of ${String(p.build).slice(0, 8)} (server ${alive(p.server) ? "running" : "gone"}, proxy ${alive(p.proxy) ? "running" : "gone"})` : "not started by this skill on this port";
  console.log(`health ${await health()} — ${who}`);
} else {
  console.log("usage: node server.mjs build | start | stop | status");
  process.exit(2);
}
