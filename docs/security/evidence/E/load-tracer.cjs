// Preload: records every resolved module path that matches WATCH (CJS + ESM, incl. dynamic import)
// and appends to TRACE_OUT on exit. Used to prove whether prisma CLI commands load mysql2.
const fs = require("node:fs");
const Module = require("node:module");
const WATCH = /[\\/]node_modules[\\/](mysql2|postgres|@prisma[\\/]studio-core|better-sqlite3)[\\/]/;
const seen = new Set();
let all = 0;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const r = origResolve.call(this, request, parent, ...rest);
  all++;
  if (WATCH.test(r)) seen.add("cjs:" + r.replace(/.*node_modules[\\/]/, ""));
  return r;
};
if (typeof Module.registerHooks === "function") {
  Module.registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context);
      all++;
      if (r && r.url && WATCH.test(decodeURIComponent(r.url))) seen.add("esm:" + decodeURIComponent(r.url).replace(/.*node_modules\//, ""));
      return r;
    },
  });
}
process.on("exit", () => {
  const line = JSON.stringify({ pid: process.pid, argv: process.argv.slice(1).map((a) => a.replace(/.*node_modules[\\/]/, "")).join(" "), resolvedTotal: all, watchedLoads: [...seen] });
  try { fs.appendFileSync(process.env.TRACE_OUT, line + "\n"); } catch {}
});
