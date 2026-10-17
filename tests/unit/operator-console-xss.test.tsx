// @vitest-environment jsdom
//
// Stored-XSS check for the operator console (opsec audit, 5 Oct 2026).
//
// The console renders text that customers and imports control: club names and
// slugs, owner names and emails, application form fields, audit-log actors,
// entity types and metadata. Each view below is rendered with hostile values
// and the resulting DOM is checked for what an injection would leave behind:
// a <script>/<img>/<iframe>/<svg> element, any on* handler attribute, or a
// link whose scheme is javascript:/data:/vbscript:. The payloads must still be
// VISIBLE as text, which proves they were rendered (escaped), not dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const IMG = `<img src=x onerror=alert(1)>`;
const BREAKOUT = `"><script>alert(1)</script>`;
const JS_URL = `javascript:alert(1)`;
const SVG = `<svg onload=alert(1)>`;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/tenants",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "t-1" }),
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("notFound"); },
}));

const tenantFixture = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/admin-auth", () => ({ isAdminPageAuthed: async () => true }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async (fn: (tx: unknown) => unknown) =>
    fn({ tenant: { findUnique: async () => tenantFixture.value } }),
}));

function assertNoInjection(container: HTMLElement) {
  expect(container.querySelectorAll("script, iframe, object, embed").length, "script-like element").toBe(0);
  // Every <img>/<svg> in these views is either absent or an icon we ship; no
  // icon carries an event handler, so checking handlers below is the real test.
  for (const el of Array.from(container.querySelectorAll("img"))) {
    expect(el.getAttribute("src"), "user-controlled <img>").not.toBe("x");
  }
  for (const el of Array.from(container.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.toLowerCase().startsWith("on"), `${el.tagName} has ${attr.name}`).toBe(false);
    }
  }
  for (const a of Array.from(container.querySelectorAll("[href], [src], [action], [formaction]"))) {
    for (const name of ["href", "src", "action", "formaction"]) {
      const v = (a.getAttribute(name) ?? "").trim().toLowerCase();
      expect(/^(javascript|data|vbscript):/.test(v), `${a.tagName} ${name}=${v}`).toBe(false);
    }
  }
}

const realFetch = globalThis.fetch;
function mockFetch(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/admin");
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("the detector itself", () => {
  it("fails on a real injection, so a green run means something", () => {
    for (const html of [IMG, `<a href="${JS_URL}">x</a>`, SVG]) {
      const { container } = render(<div dangerouslySetInnerHTML={{ __html: html }} />);
      expect(() => assertNoInjection(container), html).toThrow();
      cleanup();
    }
  });
});

describe("activity feed (cross-tenant audit log)", () => {
  it("renders hostile audit rows and metadata as text", async () => {
    mockFetch({
      "/api/admin/activity": {
        items: [
          {
            id: "a1",
            tenantId: "t1",
            tenantName: BREAKOUT,
            tenantSlug: IMG,
            actorEmail: `${JS_URL}@evil.test`,
            actorName: IMG,
            action: BREAKOUT,
            entityType: SVG,
            entityId: BREAKOUT,
            metadata: { name: IMG, url: JS_URL, html: BREAKOUT, actingAs: "x" },
            ipApprox: BREAKOUT,
            createdAt: new Date("2026-10-01T09:00:00Z").toISOString(),
          },
        ],
        nextCursor: null,
      },
    });
    const { default: ActivityFeed } = await import("@/app/admin/activity/ActivityFeed");
    const { container } = render(<ActivityFeed />);
    await waitFor(() => expect(screen.getAllByText(BREAKOUT, { exact: false }).length).toBeGreaterThan(0));
    // Expand the raw metadata view.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("onerror=alert(1)");
    expect(pre?.textContent).toContain(JS_URL);
    expect(screen.getByText(`@${IMG}`)).toBeTruthy();
    expect(screen.getByText(SVG)).toBeTruthy();
    // The only link built from the row uses the tenantId under a fixed path.
    const tenantLink = container.querySelector('a[href^="/admin/tenants/"]');
    expect(tenantLink?.getAttribute("href")).toBe("/admin/tenants/t1");
    assertNoInjection(container);
  });
});

describe("tenants list", () => {
  it("renders hostile club and owner names as text", async () => {
    const { default: TenantsList } = await import("@/app/admin/tenants/TenantsList");
    const { container } = render(
      <TenantsList
        tenants={[
          {
            id: "t1",
            name: BREAKOUT,
            slug: IMG,
            ownerEmail: JS_URL,
            ownerName: IMG,
            ownerUserId: "u1",
            memberCount: 3,
            status: "active",
            stripeConnected: false,
            stripeChargesEnabled: null,
            onboardingCompleted: true,
            createdAt: new Date("2026-10-01").toISOString(),
            deletedAt: null,
          },
        ]}
      />,
    );
    expect(screen.getByText(BREAKOUT)).toBeTruthy();
    expect(screen.getAllByText(IMG).length).toBe(2);
    expect(screen.getByText(JS_URL)).toBeTruthy();
    assertNoInjection(container);
  });
});

describe("applications inbox (public apply form fields)", () => {
  it("renders hostile application fields as text; mailto keeps its scheme", async () => {
    mockFetch({
      "/api/admin/applications": [
        {
          id: "app1",
          gymName: BREAKOUT,
          contactName: IMG,
          email: JS_URL,
          phone: SVG,
          discipline: IMG,
          memberCount: BREAKOUT,
          notes: `${BREAKOUT} ${IMG}`,
          status: "pending",
          createdAt: new Date("2026-10-01").toISOString(),
        },
      ],
    });
    const { default: ApplicationsClient } = await import("@/app/admin/applications/ApplicationsClient");
    const { container } = render(<ApplicationsClient />);
    await waitFor(() => expect(screen.getByRole("heading", { name: BREAKOUT })).toBeTruthy());
    const mail = container.querySelector('a[href^="mailto:"]');
    expect(mail?.getAttribute("href")).toBe(`mailto:${JS_URL}`);
    expect(mail?.textContent).toBe(JS_URL);
    assertNoInjection(container);
  });
});

describe("tenant detail page (server component + DangerZone + Login-as-owner)", () => {
  it("renders hostile club, slug and owner values as text", async () => {
    tenantFixture.value = {
      id: "t1",
      name: BREAKOUT,
      slug: IMG,
      subscriptionStatus: "active",
      subscriptionTier: SVG,
      currency: "GBP",
      country: BREAKOUT,
      createdAt: new Date("2026-10-01"),
      deletedAt: null,
      reviewLockedAt: null,
      stripeConnected: false,
      stripeAccountId: null,
      users: [{ id: "u1", email: JS_URL, name: IMG, totpEnabled: false, lockedUntil: null }],
      _count: { members: 1, classes: 1 },
    };
    mockFetch({ "/transfer-ownership": { candidates: [] } });
    const { default: Page } = await import("@/app/admin/tenants/[id]/page");
    const element = await Page({ params: Promise.resolve({ id: "t1" }) });
    const { container } = render(element);
    expect(screen.getAllByRole("heading", { level: 1 })[0].textContent).toBe(BREAKOUT);
    expect(container.textContent).toContain(`/login?club=${IMG}`);
    expect(container.textContent).toContain(JS_URL);
    assertNoInjection(container);
  });
});

describe("static guard over every operator-console view", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(e)) out.push(full.replace(/\\/g, "/"));
    }
    return out;
  }
  const files = walk(join(process.cwd(), "app/admin"));

  it("no file uses dangerouslySetInnerHTML, innerHTML, or document.write", () => {
    const hits = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|document\.write|insertAdjacentHTML/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("every data-built href starts with a fixed in-app path or a fixed scheme", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/href=\{`([^`]*)`\}/g)) {
        if (!/^(\/admin\/|mailto:)/.test(m[1])) bad.push(`${f}: ${m[1]}`);
      }
      // href={someVariable} — allowed only for the nav's static link table.
      for (const m of src.matchAll(/href=\{([A-Za-z_][\w.]*)\}/g)) {
        if (!(f.endsWith("AdminTopNav.tsx") && m[1] === "href") && !(f.endsWith("app/admin/page.tsx") && m[1] === "href")) {
          bad.push(`${f}: href={${m[1]}}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
