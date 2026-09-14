// The guard that stops the e2e suite writing to the production database.
//
// This is the highest-consequence control in the test infrastructure, so it has
// a test of its own. Before 14 Sep there was no single guard at all: the only
// thing between a full Playwright run and the live customer database was
// `playwright.config.ts` finding a `.env.test` file on disk and carrying on
// QUIETLY when it did not — while `.env` points at ep-bold-wave, production.
//
// The previous defence was a hand-written `beforeAll` throw copied into
// individual specs. It was present in 11 spec files and MISSING FROM 26,
// including the ones that write the most: owner-roster-flow, dashboard/members,
// dashboard/checkin, timetable-class-create, full-app-qa, member/shop.
//
// The suite does not merely read. It creates members and classes, records
// payments, resets TOTP secrets, clears lockouts and checks people in. Pointed
// at production it would corrupt the live database of a product with paying
// customers, silently, because the fallback was deliberate.
//
// A guard that has never refused anything is not a guard — hence this file.
// Every case below asserts a REFUSAL, and the last asserts the guard fails
// CLOSED: an unrecognised host is refused rather than allowed, because the cost
// of a false refusal is a confused developer and the cost of a false pass is a
// corrupted production database.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The seed check would otherwise open a real connection. Every case here is
// refused BEFORE that point, and this mock proves it: if any hostile URL ever
// reached the connection stage, `connect` would record a call and the last test
// would fail.
const { connectMock, queryMock, endMock } = vi.hoisted(() => ({
  connectMock: vi.fn(async () => {}),
  queryMock: vi.fn(async () => ({ rows: [{ slug: "total-bjj" }] })),
  endMock: vi.fn(async () => {}),
}));

vi.mock("pg", () => ({
  Client: class {
    connect = connectMock;
    query = queryMock;
    end = endMock;
  },
}));

import globalSetup from "../e2e/global-setup";

const ORIGINAL = process.env.DATABASE_URL;

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL;
});

async function attempt(url: string): Promise<string | null> {
  process.env.DATABASE_URL = url;
  try {
    await globalSetup();
    return null; // allowed
  } catch (e) {
    return (e as Error).message;
  }
}

describe("the e2e database guard refuses", () => {
  it("the PRODUCTION Neon branch, outright", async () => {
    const err = await attempt(
      "postgresql://u:p@ep-bold-wave-abt123.eu-west-2.aws.neon.tech/neondb?sslmode=require",
    );
    expect(err, "production was ALLOWED — the guard is broken").not.toBeNull();
    expect(err).toContain("E2E REFUSED TO START");
    expect(err).toContain("PRODUCTION");
  });

  it("production even when the URL is otherwise malformed", async () => {
    // Checked on the raw string before parsing, so a URL this guard cannot
    // parse still cannot slip through on a technicality.
    const err = await attempt("ep-bold-wave not even a url");
    expect(err).toContain("PRODUCTION");
  });

  it("an unrecognised remote host — it fails CLOSED", async () => {
    // The default is no. Allowing unknown hosts would mean any future database
    // is trusted by omission, which is how the original gap existed.
    const err = await attempt("postgresql://u:p@some-other-db.example.com:5432/neondb");
    expect(err).toContain("E2E REFUSED TO START");
    expect(err).toContain("unrecognised host");
  });

  it("an empty DATABASE_URL", async () => {
    const err = await attempt("");
    expect(err).toContain("E2E REFUSED TO START");
  });

  it("without ever opening a connection to any of them", () => {
    // Every refusal above happens before the seed check. If a hostile URL ever
    // reached the connection stage it would already have been trusted enough to
    // dial, which is the wrong order of operations for this control.
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe("the e2e database guard allows", () => {
  it("the test Neon branch", async () => {
    const err = await attempt(
      "postgresql://u:p@ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech/neondb?sslmode=require",
    );
    expect(err, `test branch was refused: ${err}`).toBeNull();
  });

  it("an ephemeral local Postgres, which is what CI provisions", async () => {
    const err = await attempt("postgresql://postgres:postgres@localhost:5432/postgres?schema=public");
    expect(err, `CI's own database was refused: ${err}`).toBeNull();
  });
});

describe("the e2e database guard also catches an unseeded database", () => {
  it("refuses when the seeded tenant is absent, rather than letting 30 specs fail mysteriously", async () => {
    // A correctly-pointed but empty database produces dozens of failures that
    // look like product defects. Say so once, here.
    queryMock.mockResolvedValueOnce({ rows: [] });
    const err = await attempt(
      "postgresql://u:p@ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech/neondb",
    );
    expect(err).toContain("not seeded");
  });
});
