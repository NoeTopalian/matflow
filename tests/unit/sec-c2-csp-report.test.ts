/**
 * /api/csp-report (lane C2, 9 Oct 2026): violation reports are counted, never stored, and nothing
 * from a report other than directive | blocked class | disposition reaches the log. Page addresses
 * on MatFlow are often credentials (/kiosk/<token>, /waiver/<token>), so this is the invariant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "@/app/api/csp-report/route";
import { blockedClass, cspReportTotals, resetCspReportTotals, CSP_REPORT_MAX_BYTES, MAX_KEYS } from "@/lib/csp-report";

const SECRET_DOC = "https://matflow.example/kiosk/kioskTokenSecretC2abcdef";
const SECRET_BLOCKED = "https://evil.example/steal?token=blockedSecretC2";

let logs: string[] = [];
beforeEach(() => {
  resetCspReportTotals();
  logs = [];
  for (const m of ["info", "log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

function post(body: string, type = "application/csp-report", extra: Record<string, string> = {}) {
  return POST(new Request("http://localhost/api/csp-report", { method: "POST", headers: { "content-type": type, ...extra }, body }));
}

const legacy = (o: Record<string, unknown>) => JSON.stringify({ "csp-report": o });

describe("/api/csp-report", () => {
  it("report-uri format: 204, counted by directive|class|disposition, no address in the log", async () => {
    const res = await post(legacy({
      "document-uri": SECRET_DOC,
      "blocked-uri": "inline",
      "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem",
      disposition: "report",
      "script-sample": "alert('blockedSecretC2')",
    }));
    expect(res.status).toBe(204);
    expect(cspReportTotals()).toEqual({ "script-src-elem|inline|report": 1 });
    const joined = logs.join("\n");
    expect(joined).toContain("script-src-elem|inline|report");
    expect(joined).not.toContain("kioskTokenSecretC2");
    expect(joined).not.toContain("blockedSecretC2");
  });

  it("Reporting API format (application/reports+json, batched)", async () => {
    const res = await post(JSON.stringify([
      { type: "csp-violation", url: SECRET_DOC, body: { documentURL: SECRET_DOC, blockedURL: SECRET_BLOCKED, effectiveDirective: "connect-src", disposition: "report" } },
      { type: "csp-violation", body: { documentURL: SECRET_DOC, blockedURL: "https://matflow.example/_next/x.js", effectiveDirective: "script-src-elem", disposition: "enforce" } },
      { type: "deprecation", body: { id: "x" } },
    ]), "application/reports+json");
    expect(res.status).toBe(204);
    expect(cspReportTotals()).toEqual({ "connect-src|external|report": 1, "script-src-elem|self|enforce": 1 });
    expect(logs.join("\n")).not.toMatch(/evil\.example|kioskTokenSecretC2|blockedSecretC2/);
  });

  it("refuses an oversize body by Content-Length before reading it, and by actual size when chunked", async () => {
    const big = legacy({ "blocked-uri": "inline", "effective-directive": "script-src", pad: "x".repeat(CSP_REPORT_MAX_BYTES) });
    expect((await post(big, "application/csp-report", { "content-length": String(big.length) })).status).toBe(413);
    // No Content-Length (stream body): the capped reader refuses it too.
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await POST(new Request("http://localhost/api/csp-report", { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(cspReportTotals()).toEqual({});
  });

  it("malformed bodies are a 400, never a 5xx; a directive that is not a token is bucketed as unknown", async () => {
    for (const body of ["", "not json", "null", "[]", "{}", '{"csp-report":null}', '{"csp-report":[1]}', "[1,2,3]"]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post(legacy({ "effective-directive": "script-src</script><img src=x>", "blocked-uri": 42 }))).status).toBe(204);
    expect(cspReportTotals()).toEqual({ "unknown|unknown|unknown": 1 });
  });

  it("per-instance key space is capped (a sprayer cannot grow memory without bound)", async () => {
    const dirs = "abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < 200; i++) {
      const d = `x-${dirs[i % 26]}${dirs[Math.floor(i / 26) % 26]}`;
      await post(legacy({ "effective-directive": d, "blocked-uri": "inline", disposition: "report" }));
    }
    expect(Object.keys(cspReportTotals()).length).toBeLessThanOrEqual(MAX_KEYS);
  });

  it("only 50 reports from one request are tallied", async () => {
    const batch = Array.from({ length: 120 }, () => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "data:", disposition: "report" } }));
    expect((await post(JSON.stringify(batch), "application/reports+json")).status).toBe(204);
    expect(cspReportTotals()["img-src|data|report"]).toBe(50);
  });

  it("blockedClass never returns the address", () => {
    expect(blockedClass("inline")).toBe("inline");
    expect(blockedClass("eval")).toBe("eval");
    expect(blockedClass("data:image/png;base64,AAA")).toBe("data");
    expect(blockedClass("blob:https://x/1")).toBe("blob");
    expect(blockedClass("https://a.example/p?q=1", "https://a.example/kiosk/t")).toBe("self");
    expect(blockedClass(SECRET_BLOCKED, SECRET_DOC)).toBe("external");
    expect(blockedClass("chrome-extension://abc")).toBe("other");
    expect(blockedClass(undefined)).toBe("unknown");
  });
});
