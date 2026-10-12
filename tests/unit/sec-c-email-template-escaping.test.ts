// Security campaign lane C — SEC-035 (template injection) / SEC-041 (stored XSS
// via mail): every transactional template in lib/email.ts is rendered through
// the real sendEmail() with EVERY variable set to a hostile value, and the HTML
// handed to the (faked) Resend client must contain no live markup from it.
// Variables are supplied through a Proxy, so a template that reads a variable
// this test does not know about still receives the payload.
//
// Synthetic only: Resend is a recording fake, the database is a fake, no network.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const h = vi.hoisted(() => ({ sent: [] as Array<{ subject: string; html: string; text: string; to: unknown; replyTo?: unknown }> }));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (a: { subject: string; html: string; text: string; to: unknown; replyTo?: unknown }) => {
        h.sent.push(a);
        return { data: { id: "secC-resend-id" }, error: null };
      },
    };
  },
}));
vi.mock("@/lib/email-delivery", async (orig) => ({
  ...(await orig<object>()),
  isEmailDeliveryOn: () => true,
}));
vi.mock("@/lib/prisma-tenant", () => {
  const tx = new Proxy(
    {},
    {
      get: (_t, model) =>
        model === "then"
          ? undefined
          : new Proxy({}, {
              get: (_m, method) =>
                method === "then"
                  ? undefined
                  : async () => (String(method).startsWith("find") ? null : String(method).endsWith("Many") ? { count: 0 } : { id: "secC-log" }),
            }),
    },
  );
  return {
    withTenantContext: async (_t: string, fn: (t: unknown) => unknown) => fn(tx),
    withRlsBypass: async (fn: (t: unknown) => unknown) => fn(tx),
  };
});

import { sendEmail } from "@/lib/email";

const PAYLOAD = `secC<script>alert(1)</script>"'><img src=x onerror=alert(2)><a href="javascript:alert(3)">x</a>`;
const BENIGN = "secCbenign";
const varsOf = (v: string) => new Proxy({} as Record<string, string>, { get: (_t, k) => (typeof k === "string" ? v : undefined) });

/**
 * The markup skeleton: every tag name with its attribute names, in order. If a
 * variable is escaped, the hostile render has exactly the benign render's
 * skeleton; a single unescaped `<` or a quote breaking out of an attribute
 * changes it.
 */
function skeleton(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>/g)].map(
    (m) =>
      `${m[1].toLowerCase()}[${[...m[2].matchAll(/\s+([^\s=>"']+)(?:=(?:"[^"]*"|'[^']*'|[^\s>"']*))?/g)]
        .map((a) => a[1].toLowerCase())
        .join(",")}]`,
  );
}

// Every TemplateId in lib/email.ts (type TemplateId). Read from the source so a new template is covered automatically.
import fs from "node:fs";
import path from "node:path";
const src = fs.readFileSync(path.resolve(__dirname, "../../lib/email.ts"), "utf8");
const TEMPLATE_IDS = [...(src.match(/type TemplateId =([^;]+);/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

const URL_VARS = new Set<string>();
// Reviewed 9 Oct 2026: every one of these hrefs is getBaseUrl()/NEXTAUTH_URL + a constant path, a
// server-minted token, or a Stripe/route path (loginUrl, link, portalUrl, dashboardUrl, paymentsUrl,
// actionUrl, disownLink) — never member- or club-entered text.
const EXPECTED_URL_VARS: string[] = [
  "application_internal",
  "dispute_created",
  "dispute_opened_owner",
  "invite_member",
  "kiosk_waiver",
  "login_new_device",
  "magic_link",
  "member_action_assigned",
  "owner_activation",
  "payment_failed",
  "payment_failed_owner",
  "stripe_disconnected_owner",
  "welcome"
];

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_secC_synthetic_not_a_key";
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
});

describe("SEC-035 / SEC-041 mail templates escape every variable", () => {
  it("found the template list", () => {
    expect(TEMPLATE_IDS.length).toBeGreaterThanOrEqual(20);
  });

  it("positive control: the skeleton detector sees an unescaped payload", () => {
    expect(skeleton(`<p>${PAYLOAD}</p>`)).not.toEqual(skeleton(`<p>${BENIGN}</p>`));
    expect(skeleton(`<a href="${PAYLOAD}">x</a>`)).not.toEqual(skeleton(`<a href="${BENIGN}">x</a>`));
  });

  async function render(id: string, value: string) {
    h.sent.length = 0;
    await sendEmail({ tenantId: "secC-tenant", templateId: id as never, to: "secc-recipient@secc.example", vars: varsOf(value) });
    expect(h.sent, `${id} was not handed to the mail client`).toHaveLength(1);
    return h.sent[0];
  }

  for (const id of TEMPLATE_IDS) {
    it(`${id}: hostile variables leave the markup skeleton unchanged`, async () => {
      const benign = await render(id, BENIGN);
      const hostile = await render(id, PAYLOAD);
      // The variable was rendered at all (otherwise the comparison proves nothing).
      expect(hostile.html.includes("secC") || hostile.subject.includes("secC")).toBe(true);
      expect(skeleton(hostile.html)).toEqual(skeleton(benign.html));
      expect(hostile.html).not.toMatch(/<script/i);
      // Where a variable lands in an href, record it: escaping keeps it inside the attribute, but a
      // javascript: scheme would survive escaping, so any such href must come from a server-built URL.
      const hrefs = [...hostile.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      for (const href of hrefs) {
        if (href.includes("secC")) URL_VARS.add(`${id}`);
        expect(href).not.toMatch(/^\s*javascript:/i);
      }
    });
  }

  it("templates whose hrefs carry a variable (provenance reviewed in the lane C report)", () => {
    // Recorded, not failed: every one of these is built by the server from APP_URL / a token / a
    // route, not from member or club input. The list is pinned so a new one is reviewed.
    expect([...URL_VARS].sort()).toEqual(EXPECTED_URL_VARS);
  });
});
