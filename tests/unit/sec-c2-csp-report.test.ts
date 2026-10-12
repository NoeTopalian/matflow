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

  // Lane C3 (review R5 §1): the cell above pads RELATIVE to CSP_REPORT_MAX_BYTES, so raising the cap
  // (to 32 KB) survived, and the capped reader answers 413 on its own, so removing the Content-Length
  // pre-check survived too. These cells pin the absolute bound and the "refused before reading" order.
  describe("absolute bound and refusal before the body is read (lane C3)", () => {
    const ABS_LIMIT_PROBE = 20 * 1024; // absolute: does not move if the constant does
    /** A well-formed report of exactly `bytes` bytes, so only its size can make it fail. */
    const reportOfBytes = (bytes: number) => {
      const shell = legacy({ "blocked-uri": "inline", "effective-directive": "script-src", disposition: "report", pad: "" });
      const out = legacy({ "blocked-uri": "inline", "effective-directive": "script-src", disposition: "report", pad: "x".repeat(bytes - shell.length) });
      expect(new TextEncoder().encode(out).byteLength).toBe(bytes);
      return out;
    };
    const lazyStream = (text: string, pulls: { n: number }) =>
      new ReadableStream<Uint8Array>(
        { pull(c) { pulls.n++; c.enqueue(new TextEncoder().encode(text)); c.close(); } },
        { highWaterMark: 0 }, // nothing is pulled until someone reads
      );

    it("positive control: a well-formed 15 KB report is accepted (204)", async () => {
      expect((await post(reportOfBytes(15 * 1024))).status).toBe(204);
      expect(cspReportTotals()).toEqual({ "script-src|inline|report": 1 });
    });

    it("an ABSOLUTE 20 KB report is refused 413 with an honest Content-Length and when chunked", async () => {
      const body = reportOfBytes(ABS_LIMIT_PROBE);
      expect((await post(body, "application/csp-report", { "content-length": String(ABS_LIMIT_PROBE) })).status).toBe(413);
      const pulls = { n: 0 };
      const chunked = await POST(new Request("http://localhost/api/csp-report", {
        method: "POST", headers: { "content-type": "application/csp-report" }, body: lazyStream(body, pulls), duplex: "half",
      } as RequestInit));
      expect(chunked.status).toBe(413);
      expect(pulls.n).toBe(1); // the chunked path really is judged by reading
      expect(cspReportTotals()).toEqual({});
    });

    it("a declared Content-Length over the bound is refused WITHOUT pulling a byte of the body", async () => {
      const pulls = { n: 0 };
      const res = await POST(new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report", "content-length": String(ABS_LIMIT_PROBE) },
        body: lazyStream(reportOfBytes(ABS_LIMIT_PROBE), pulls),
        duplex: "half",
      } as RequestInit));
      expect(res.status).toBe(413);
      expect(pulls.n).toBe(0);
    });

    it("…and without touching any body accessor of the request", async () => {
      const touched: string[] = [];
      const real = new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report", "content-length": String(ABS_LIMIT_PROBE) },
        body: reportOfBytes(ABS_LIMIT_PROBE),
      });
      const BODY_ACCESSORS = new Set(["body", "text", "json", "arrayBuffer", "blob", "formData", "bytes", "clone", "bodyUsed"]);
      const spy = new Proxy(real, {
        get(target, prop) {
          if (typeof prop === "string" && BODY_ACCESSORS.has(prop)) touched.push(prop);
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      expect((await POST(spy)).status).toBe(413);
      expect(touched).toEqual([]);
      expect(real.bodyUsed).toBe(false);
    });
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
