// The kiosk must not hand out children's dates of birth.
//
// `GET /api/kiosk/[token]/members` is unauthenticated BY DESIGN — the kiosk URL
// in a front-desk tablet's address bar is its only credential — it is excluded
// from middleware, and it searches on a two-character prefix. It was returning
// `dateOfBirth` for every linked child, so anyone with that URL could walk the
// roster and harvest minors' exact birth dates. The route's own header comment
// claimed the response "intentionally omits PII (email, phone, DOB…)".
//
// The picker only ever displayed a derived age, so the date never needed to
// leave the server. These tests fail if it starts leaving again.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { ageFromDateOfBirth } from "@/lib/age";

const TENANT = "tenant_a";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { mockFindFirst, mockFindMany, mockRateLimit } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findFirst: mockFindFirst } }),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ member: { findMany: mockFindMany } }),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockRateLimit,
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/lib/kiosk-token", () => ({
  signKioskMemberToken: () => "signed_token",
}));

type Route = typeof import("@/app/api/kiosk/[token]/members/route");
let GET: Route["GET"];

beforeAll(async () => {
  ({ GET } = await import("@/app/api/kiosk/[token]/members/route"));
});

/** A parent with one child born 1 Jan 2015. */
function parentWithKid() {
  return [
    {
      id: "mem_parent",
      name: "Alex Parent",
      accountType: "parent",
      parentMemberId: null,
      waiverAccepted: true,
      membershipType: "Monthly",
      memberRanks: [],
      children: [
        {
          id: "mem_kid",
          name: "Sam Kid",
          accountType: "kids",
          waiverAccepted: true,
          dateOfBirth: new Date("2015-01-01T00:00:00Z"),
        },
      ],
    },
  ];
}

// The route refuses any token shorter than 16 characters before it does
// anything else, so the fixture has to look like a real kiosk token.
const KIOSK_TOKEN = "kiosk_token_abcdefghijklmnop";

function req(q = "sam") {
  return new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/members?q=${q}`);
}
const params = Promise.resolve({ token: KIOSK_TOKEN });

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockFindFirst.mockResolvedValue({ id: TENANT });
  mockFindMany.mockResolvedValue(parentWithKid());
});

describe("kiosk member search — minors' PII", () => {
  it("NEVER returns a child's date of birth, anywhere in the payload", async () => {
    const res = await GET(req(), { params });
    const body = await res.json();

    // Serialise the whole response and look for the date in any form. A field
    // rename or a nested copy would still be caught.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("dateOfBirth");
    expect(serialised).not.toContain("2015-01-01");
    expect(serialised).not.toContain("2015");
  });

  it("returns a derived age instead, so the picker still works", async () => {
    const res = await GET(req(), { params });
    const body = await res.json();

    const kid = body.members[0].linkedKids[0];
    expect(kid.age).toBe(ageFromDateOfBirth(new Date("2015-01-01T00:00:00Z")));
    expect(typeof kid.age).toBe("number");
  });

  it("still returns the fields the kiosk genuinely needs", async () => {
    const res = await GET(req(), { params });
    const kid = (await res.json()).members[0].linkedKids[0];

    expect(kid.name).toBe("Sam Kid");
    expect(kid.waiverOk).toBe(true);
    expect(kid.kioskMemberToken).toBe("signed_token");
  });

  it("sends a null age rather than omitting the field when there is no DOB", async () => {
    const rows = parentWithKid();
    rows[0].children[0].dateOfBirth = null as unknown as Date;
    mockFindMany.mockResolvedValue(rows);

    const kid = (await (await GET(req(), { params })).json()).members[0].linkedKids[0];
    expect(kid.age).toBeNull();
  });
});

describe("ageFromDateOfBirth", () => {
  it("returns null for a missing or unparseable date rather than guessing", () => {
    expect(ageFromDateOfBirth(null)).toBeNull();
    expect(ageFromDateOfBirth(undefined)).toBeNull();
    expect(ageFromDateOfBirth("not a date")).toBeNull();
  });

  it("rejects a future date of birth as bad data, not a negative age", () => {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    expect(ageFromDateOfBirth(nextYear)).toBeNull();
  });

  it("has not had this year's birthday yet — counts a year less", () => {
    const now = new Date();
    const dob = new Date(now);
    dob.setFullYear(now.getFullYear() - 10);
    dob.setDate(dob.getDate() + 1); // birthday is tomorrow
    expect(ageFromDateOfBirth(dob)).toBe(9);
  });

  it("had this year's birthday already — counts the full year", () => {
    const now = new Date();
    const dob = new Date(now);
    dob.setFullYear(now.getFullYear() - 10);
    dob.setDate(dob.getDate() - 1); // birthday was yesterday
    expect(ageFromDateOfBirth(dob)).toBe(10);
  });
});
