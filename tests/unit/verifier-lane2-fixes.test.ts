// Independent verifier lane 2 (member portal), 30 Sep 2026, on the frozen
// production build:
// 1 Home "Sign In to Class" said "Signed in!" for a cancelled session, sending
//   nothing to the server (no session id → success path);
// 2 the kiosk's "Send waiver link" always answered 401: the proxy gated the
//   kiosk waiver routes behind a staff session the tablet does not have;
// 3 a club with no products showed invented ones and took orders for them;
// 6 kiosk-request would email a child's synthesised address.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("1 — no session, no 'Signed in!'", () => {
  it("refuses before the success path when the class has no session today", () => {
    const s = src("app/member/home/page.tsx");
    const guard = s.indexOf("if (!cls.classInstanceId) {");
    expect(guard).toBeGreaterThan(-1);
    expect(s.slice(guard, guard + 400)).toMatch(/setError\(/);
    expect(s.slice(guard, guard + 400)).toMatch(/return;/);
  });
});

describe("2 — the kiosk tablet reaches its waiver routes", () => {
  it("lists kiosk-request and kiosk-status as public (they authenticate by kiosk token)", () => {
    const s = src("proxy.ts");
    expect(s).toMatch(/"\/api\/waiver\/kiosk-request"/);
    expect(s).toMatch(/"\/api\/waiver\/kiosk-status"/);
    // …and the signing routes stay protected.
    expect(s).not.toMatch(/"\/api\/waiver\/sign"/);
  });
  it("kiosk-request still requires the kiosk device token", () => {
    expect(src("app/api/waiver/kiosk-request/route.ts")).toMatch(/kioskTokenHash: deviceTokenHash/);
  });
});

describe("3 — only the club's own products", () => {
  it("never serves or prices the demo catalogue for a real club", () => {
    const products = src("app/api/member/products/route.ts");
    const checkout = src("app/api/member/checkout/route.ts");
    // The demo catalogue appears only behind the demo-tenant check.
    expect(products.match(/return NextResponse\.json\(PRODUCTS\)/g)?.length).toBe(1);
    expect(products).toMatch(/if \(tenantId === "demo-tenant"\) \{\s*return NextResponse\.json\(PRODUCTS\);/);
    expect(checkout.match(/PRODUCT_PRICE_MAP/g)?.length).toBe(2); // import + demo-tenant line
  });
});

describe("6 — no kiosk mail to an address with no inbox", () => {
  it("refuses synthesised child and erased addresses before sending", () => {
    const s = src("app/api/waiver/kiosk-request/route.ts");
    const refuse = s.indexOf('endsWith("@no-login.matflow.local")');
    const send = s.indexOf("await sendEmail(");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(send);
  });
});
