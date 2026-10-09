// Lane C bounded HTTP probe (SEC-041/043/044/045/046/047/048) against a LOCAL production-mode
// server (next start on 127.0.0.1, TEST database, TESTING_MODE off, providers isolated).
// Usage: node http-probe.mjs http://127.0.0.1:3963 > out.json
// Unauthenticated requests only; ~40 requests; no writes succeed (cross-site/unauth refusals).
import http from "node:http";

const BASE = process.argv[2] ?? "http://127.0.0.1:3963";
const u = new URL(BASE);

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request(
      { host: u.hostname, port: u.port, path, method, headers: { host: `${u.hostname}:${u.port}`, ...headers }, timeout: 15000 },
      (res) => {
        let data = "";
        res.on("data", (c) => { if (data.length < 200000) data += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    r.on("error", (e) => resolve({ status: -1, headers: {}, body: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: -1, headers: {}, body: "timeout" }); });
    if (body) r.write(body);
    r.end();
  });
}
const pick = (h, ks) => Object.fromEntries(ks.map((k) => [k, h[k] ?? null]));
const SEC = ["content-security-policy", "x-frame-options", "strict-transport-security", "x-content-type-options", "cross-origin-opener-policy", "cross-origin-resource-policy", "referrer-policy", "cache-control", "location", "access-control-allow-origin", "access-control-allow-credentials", "content-type", "x-powered-by", "vary"];
const out = {};
const rec = async (name, path, opts, extra) => {
  const r = await req(path, opts);
  out[name] = { path, method: opts?.method ?? "GET", sentHeaders: opts?.headers ?? {}, status: r.status, headers: pick(r.headers, SEC), ...(extra ? extra(r) : {}) };
  return r;
};

// SEC-044 / headers on representative surfaces
for (const [n, p] of [["home", "/"], ["login", "/login"], ["health", "/api/health"], ["dashboard_unauth", "/dashboard"], ["member_unauth", "/member/home"], ["admin_unauth", "/admin"], ["api_members_unauth", "/api/members"], ["api_me_gym_unauth", "/api/me/gym"], ["api_admin_unauth", "/api/admin/activity"]]) {
  await rec(n, p);
}
// SEC-043 CORS
await rec("cors_preflight_members", "/api/members", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
await rec("cors_simple_get_health", "/api/health", { headers: { origin: "https://evil.example" } });
await rec("cors_preflight_admin", "/api/admin/customers/x/login-email", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
// SEC-042 cross-site POST before auth (text/plain, no preflight)
await rec("csrf_products_xsite", "/api/products", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: '{"name":"secC"}' });
await rec("csrf_login_email_xsite", "/api/admin/customers/x/login-email", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: '{"action":"mark_provisional"}' });
// SEC-045 host header / redirect
await rec("host_magic_verify", "/api/magic-link/verify?token=secC-invalid", { headers: { host: "evil.example" } });
await rec("xfh_magic_verify", "/api/magic-link/verify?token=secC-invalid", { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } });
await rec("host_dashboard", "/dashboard", { headers: { host: "evil.example" } });
await rec("nextauth_callback_offsite", "/api/auth/signin?callbackUrl=https%3A%2F%2Fevil.example%2F", {}, (r) => ({ bodyMentionsEvil: r.body.includes("evil.example") }));
await rec("legacy_checkin_redirect", "/checkin/secc");
// SEC-048 middleware bypass header (CVE-2025-29927 shape) and RSC/Server Action probes
for (const v of ["middleware", "middleware:middleware:middleware:middleware:middleware", "proxy:proxy:proxy:proxy:proxy", "src/middleware:src/middleware:src/middleware:src/middleware:src/middleware"]) {
  await rec(`mw_bypass_${v.split(":").length}_${v.split(":")[0].replace("/", "_")}`, "/dashboard", { headers: { "x-middleware-subrequest": v } });
}
await rec("rsc_dashboard_unauth", "/dashboard", { headers: { rsc: "1", "next-router-state-tree": "%5B%22%22%5D" } }, (r) => ({ bodyLooksLikeFlight: /^\d+:/m.test(r.body.slice(0, 200)), bodyBytes: r.body.length }));
await rec("rsc_query_dashboard_unauth", "/dashboard?_rsc=secc1", { headers: { rsc: "1" } }, (r) => ({ bodyLooksLikeFlight: /^\d+:/m.test(r.body.slice(0, 200)), bodyBytes: r.body.length }));
await rec("rsc_admin_unauth", "/admin", { headers: { rsc: "1" } }, (r) => ({ bodyLooksLikeFlight: /^\d+:/m.test(r.body.slice(0, 200)), bodyBytes: r.body.length }));
await rec("server_action_unknown", "/login", { method: "POST", headers: { "next-action": "0123456789abcdef0123456789abcdef01234567", "content-type": "text/plain;charset=UTF-8", origin: `http://${u.hostname}:${u.port}` }, body: "[]" }, (r) => ({ bodyHasStack: /at .*\(.*:\d+:\d+\)/.test(r.body), bodyBytes: r.body.length }));
// SEC-041 reflected input
const P = encodeURIComponent('<script>secCxss</script>"\'><img src=x onerror=secC>');
await rec("reflect_login_error", `/login?error=${P}`, {}, (r) => ({ rawReflected: r.body.includes("<script>secCxss") || r.body.includes("<img src=x onerror=secC>") }));
await rec("reflect_404", `/secc-${P}`, {}, (r) => ({ rawReflected: r.body.includes("<script>secCxss") }));
await rec("reflect_tenant_api", `/api/tenant/${P}`, {}, (r) => ({ rawReflected: r.body.includes("<script>secCxss") }));
await rec("reflect_slug_page", `/secc${P}`, {}, (r) => ({ rawReflected: r.body.includes("<script>secCxss") }));
// SEC-038 traversal on static and blob proxy
for (const p of ["/_next/static/..%2f..%2f.env", "/_next/static/%2e%2e/%2e%2e/.env", "/..%2f.env", "/.env", "/_next/../.env", "/api/blob-image?url=https%3A%2F%2Fx.blob.vercel-storage.com%2Ftenants%2F..%2F..%2Fsecc"]) {
  await rec(`traversal_${p}`, p, {}, (r) => ({ leakedEnv: /DATABASE_URL|NEXTAUTH_SECRET|AUTH_SECRET=/.test(r.body) }));
}
// SEC-046 conflicting framing (bounded: one request, local only)
await rec("te_cl_conflict", "/api/health", { method: "GET", headers: { "content-length": "4", "transfer-encoding": "chunked" }, body: "0\r\n\r\n" });

console.log(JSON.stringify({ base: BASE, at: new Date().toISOString(), results: out }, null, 1));
