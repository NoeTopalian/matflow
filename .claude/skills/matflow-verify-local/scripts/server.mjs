// Production build and server of a MatFlow worktree against the Neon TEST branch. Run from the worktree root.
//   node server.mjs build     `next build` with no database URL in its environment (never `npm run build`, whose
//                             scripts/maybe-migrate.mjs migrates whatever database URL the shell holds)
//   node server.mjs start     next start on 127.0.0.1:MF_PORT + HTTPS proxy on localhost:MF_PORT+2, detached
//   node server.mjs stop      stops both
//   node server.mjs status    HTTP status of /api/health through the proxy
// On Windows run builds from PowerShell: Turbopack under the Bash tool fails with 0xc0000142.
import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP, OUT, DATA, PORT, PUB, BASE, appEnv, buildEnv, assertWorktree, node24 } from "./env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PIDS = `${OUT}/pids-${PORT}.json`;
const TLS = `${DATA}/tls`;
const git = (...args) => spawnSync("git", args, { cwd: APP, encoding: "utf8" }).stdout.trim();

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

const [cmd] = process.argv.slice(2);
if (cmd === "build") {
  assertWorktree();
  const r = spawnSync(node24(), ["node_modules/next/dist/bin/next", "build"], { cwd: APP, env: buildEnv(), stdio: "inherit" });
  console.log(`BUILD EXIT ${r.status} commit ${git("rev-parse", "HEAD")} tree ${git("status", "--porcelain") ? "DIRTY" : "clean"}`);
  process.exit(r.status ?? 1);
} else if (cmd === "start") {
  assertWorktree();
  if (!fs.existsSync(`${APP}/.next/BUILD_ID`)) throw new Error("no production build — run: node server.mjs build");
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
  const server = launch(["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(PORT)], APP, `server-${PORT}.log`, env);
  const proxy = launch([`${HERE}/tls-proxy.mjs`, String(PORT), String(PUB), TLS], HERE, `proxy-${PORT}.log`, { ...process.env });
  fs.writeFileSync(PIDS, JSON.stringify({ server, proxy, app: APP }));
  console.log(`started server pid ${server} (127.0.0.1:${PORT}) and proxy pid ${proxy} (${BASE}); logs in ${OUT}`);
} else if (cmd === "stop") {
  const p = fs.existsSync(PIDS) ? JSON.parse(fs.readFileSync(PIDS, "utf8")) : {};
  for (const pid of [p.server, p.proxy].filter(Boolean)) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else try { process.kill(pid); } catch {}
  }
  fs.rmSync(PIDS, { force: true });
  console.log("stopped");
} else if (cmd === "status") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const r = await fetch(`${BASE}/api/health`).then((x) => x.status, (e) => `down (${e.cause?.code ?? e.message})`);
  console.log(`health ${r}`);
} else {
  console.log("usage: node server.mjs build | start | stop | status");
  process.exit(2);
}
