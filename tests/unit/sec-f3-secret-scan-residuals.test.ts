/**
 * Lane F3 (iteration 2, SF-82 residuals from review R3 §10): lower-case names, any other *_PASSWORD / *_SECRET /
 * *_TOKEN name, and a password containing the word "example" with a random-looking stretch left. Synthetic values
 * are generated at run time (never real, never committed as literals) and must never be echoed by a finding.
 *
 * The generator is seeded (23 Nov 2026): with a fresh random value on every run, about 1 run in 190 drew an
 * "example" value whose other 16 characters repeated enough to fall under the scanner's entropy line, and the case
 * failed in CI (run 44813215463). Same values on every run now; the low-entropy shape is its own fixed case below.
 */
import { describe, expect, it } from "vitest";
import { scanText, embeddedMarkerRandom } from "../../scripts/readiness/secret-scan.mjs";

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let seed = 0x5f3a82c1;
/** mulberry32: a fixed stream, so every run builds the same synthetic values. */
const next = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const b62 = (n: number) => Array.from({ length: n }, () => B62[Math.floor(next() * 62)]).join("");
/** Guaranteed upper + lower + digit. */
const rnd = (n: number) => `Q${b62(n - 3)}k7`;
const join = (...p: string[]) => p.join("");
type F = { rule: string; classification: string };
const kinds = (t: string, loc = "plant.txt") => scanText(t, loc).map((f: F) => `${f.rule}:${f.classification}`);

describe("SF-82 residuals: now reported as candidates", () => {
  it.each([
    ["lower-case operator_password (R3 plant)", () => join("operator", "_password=", rnd(20)), "password-env-assignment"],
    ["mixed-case Operator_Password", () => join("Operator", "_Password=", rnd(20)), "password-env-assignment"],
    ["lower-case nextauth_secret", () => join("nextauth", "_secret=", rnd(40)), "secret-env-assignment"],
    ["lower-case migration_database_url", () => join("migration_database", "_url=postgresql://neondb_owner:", rnd(9), "@ep-planted.eu-west-2.aws.neon.tech/neondb"), "database-url-env-assignment"],
    ["SMTP_PASSWORD (R3 plant)", () => join("SMTP", "_PASSWORD=", rnd(20)), "generic-secret-assignment"],
    ["smtp_password, lower case", () => join("smtp", "_password=", rnd(20)), "generic-secret-assignment"],
    ["SENDGRID_API_TOKEN quoted in code", () => join('const SENDGRID_API', '_TOKEN = "', rnd(32), '";'), "generic-secret-assignment"],
    ["MAIL_SECRET in JSON", () => join('{"MAIL', '_SECRET": "', rnd(24), '"}'), "generic-secret-assignment"],
    ["REDIS_PASSWORD as a YAML line", () => join("  REDIS", "_PASSWORD: ", rnd(18)), "generic-secret-assignment"],
    ["HOOK_TOKEN tight inside a command line", () => join("curl -d HOOK", "_TOKEN=", rnd(26), " https://hooks.invalid"), "generic-secret-assignment"],
    ["a SHORT human password in an env file (any non-empty value)", () => join("SMTP", "_PASSWORD=hunter2"), "generic-secret-assignment"],
    ["Neon URL password with 'example' inside it (R3 plant)", () => join("postgresql://neondb_owner:", rnd(8), "example", rnd(8), "@ep-planted.eu-west-2.aws.neon.tech/neondb"), "postgres-url-with-password"],
    ["assignment value with 'example' inside it", () => join("SMTP", "_PASSWORD=", rnd(8), "example", rnd(8)), "generic-secret-assignment"],
  ])("%s", (_l, make, rule) => {
    const text = `${make()}\n`;
    const loc = /SHORT/.test(_l) ? ".env.production" : "plant.txt";
    const findings = scanText(text, loc);
    const hit = findings.find((f: F) => f.rule === rule && f.classification === "candidate");
    expect(hit, `${rule} not a candidate: ${kinds(text, loc).join(",")}`).toBeTruthy();
    const v = text.trim();
    expect(JSON.stringify(findings)).not.toContain(v.slice(-8));
  });

  it("the R3 'example' plant: the marker sits INSIDE one token, so the halves count as one stretch", () => {
    expect(embeddedMarkerRandom(join(rnd(8), "example", rnd(8)))).toBe(true);
    // A marker between separators or at a token's edge splits nothing (E3 behaviour kept).
    expect(embeddedMarkerRandom(join("vercel_blob", "_rw_FakeStore_FakeTokenValue1234"))).toBe(false);
    expect(embeddedMarkerRandom("replace-with-openssl-rand-base64-32")).toBe(false);
  });
});

/**
 * Finding of 22 Nov 2026: a value containing "1234", "example", "fake" or "dummy" was classed `placeholder` whenever
 * nothing random-looking was left, so a password a person chose passed the scan. Fixed shapes, invented for this file.
 */
describe("a credential is not exempt merely because it contains 1234, example, fake or dummy", () => {
  const NEON = "@ep-planted.eu-west-2.aws.neon.tech/neondb";
  it.each([
    ["a name followed by 1234", "Marlowe1234"],
    ["a name, 1234 and a symbol", "Marlowe1234!"],
    ["a credential word followed by 1234", "Password1234"],
    ["test1234", "test1234"],
    ["nothing but a digit run", "12345678"],
    ["words around 'example'", "gym-example-2026"],
    ["a word starting Fake", "Fakenham-road-7"],
    ["a word starting dummy", "dummyrun-tuesday"],
    ["1234 in the middle of mixed characters", "Tq7b1234Zw9k"],
    ["'fake' inside 16 lower-case letters", "mbqfakertwzlopnv"],
    ["'example' with repeated characters either side (the shape the flaky case drew)", "QaabbaK7exampleQccddck7"],
  ])("%s: a candidate in an env file, as a URL password and in a named assignment", (_l, value) => {
    const cases: [string, string, string][] = [
      [join("SMTP", "_PASSWORD=", value), ".env.production", "generic-secret-assignment"],
      [join("postgresql://neondb_owner:", value.replace("!", "%21"), NEON), "plant.txt", "postgres-url-with-password"],
      [join("operator", "_password=", value), "plant.txt", "password-env-assignment"],
    ];
    for (const [text, loc, rule] of cases) {
      const findings = scanText(`${text}\n`, loc);
      const hit = findings.find((f: F) => f.rule === rule && f.classification === "candidate");
      expect(hit, `${rule} in ${loc}: ${kinds(`${text}\n`, loc).join(",")}`).toBeTruthy();
      expect(JSON.stringify(findings)).not.toContain(value);
    }
  });

  it.each([
    ["the bare word", "example"],
    ["marker and credential words only", "my-example-password"],
    ["marker and credential words only, camel case", "FakeTokenValue1234"],
    ["dummy key", "dummy-api-key"],
    ["a strong marker beside a weak one", "replace-with-example-1234"],
    ["not-a-real", "not-a-real-key-1234"],
  ])("still a placeholder: %s", (_l, value) => {
    for (const [text, loc] of [
      [join("SMTP", "_PASSWORD=", value), ".env.example"],
      [join("postgresql://neondb_owner:", value, NEON), "plant.txt"],
    ]) {
      const k = kinds(`${text}\n`, loc);
      expect(k.length, text.slice(0, 12)).toBeGreaterThan(0);
      expect(k.filter((x: string) => !x.endsWith(":placeholder")), `${loc}: ${k.join(",")}`).toEqual([]);
    }
  });

  it("a word in another script is a word: it is not dropped before the filler check", () => {
    const f = scanText(join("SMTP", "_PASSWORD=fake-пароль-7\n"), ".env.production");
    expect(f.map((x: F) => x.classification)).toEqual(["candidate"]);
  });

  it("a marker in the middle of a random-looking token still leaves a candidate when another marker follows it", () => {
    const f = scanText(join("SMTP", "_PASSWORD=MbqRtWzLoPnV", "dummy", "probe\n"), ".env.production");
    expect(f.map((x: F) => x.classification)).toEqual(["candidate"]);
  });

  it("in source (not a config file) a readable value with a marker is `literal`, as any readable value is: counted, never hidden", () => {
    const f = scanText(join('const SMTP', '_PASSWORD = "Marlowe1234";\n'), "lib/mail.ts");
    expect(f.map((x: F) => `${x.rule}:${x.classification}`)).toEqual(["generic-secret-assignment:literal"]);
  });
});

describe("SF-82 residuals: generic rule — references, placeholders and code are not findings", () => {
  it.each([
    ["${} interpolation", join("SMTP", "_PASSWORD=${SMTP_PASSWORD}")],
    ["process.env reference", join("SMTP", "_PASSWORD=process.env.SMTP_PASSWORD")],
    ["shell variable", join("docker build --build-arg SMTP", "_PASSWORD=$SMTP_PASSWORD .")],
    ["dotted reference in code", join("    refresh", "_token: tokens.refresh_token,")],
    ["call expression in code", join("    access", "_token: String(tokens.access_token)),")],
    ["TypeScript type annotation", join("  CRON", "_SECRET: string;")],
    ["ternary with a message string", join('const e = weak ? WEAK_TEMP', '_PASSWORD : "Invalid data";')],
    ["comparison", join('if (input.RESET', '_TOKEN === "x") {}')],
    ["placeholder word", join("SMTP", "_PASSWORD=changeme")],
    ["your-… placeholder", join("API", "_TOKEN=your-api-token")],
    ["angle-bracket slot", join("API", "_TOKEN=<token>")],
    ["replace-with assignment", join("SMTP", '_SECRET="replace-with-openssl-rand-base64-32"')],
    ["empty value", join("SMTP", "_PASSWORD=")],
    ["migration name ending _token keyed to a checksum", join('"20260504100000_tenant_kiosk', '_token": "', "ab12".repeat(16), '"')],
    ["localhost URL with 'example' password", "postgresql://user:example@localhost:5432/db"],
    ["'example' between separators in a URL password", join("postgresql://neondb_owner:", "my-example-password", "@ep-x.eu-west-2.aws.neon.tech/db")],
  ])("negative control: %s", (_l, text) => {
    expect(kinds(text).filter((k: string) => k.endsWith(":candidate"))).toEqual([]);
  });

  it("a human-readable hard-coded fixture in SOURCE is reported as `literal` (counted, not failing), never hidden", () => {
    const f = scanText(join('export const THROWAWAY', '_PASSWORD = "Throwaway-pass-1!";\n'), "tests/e2e/x-shared.ts");
    expect(f.map((x: F) => `${x.rule}:${x.classification}`)).toEqual(["generic-secret-assignment:literal"]);
  });
  it("the same literal in an env/config file is a candidate", () => {
    for (const loc of [".env", ".env.local", "deploy/app.yaml", "config.toml", "x/.env.production@blob:0123456789"]) {
      const f = scanText(join("SMTP", "_PASSWORD=Throwaway-pass-1!\n"), loc);
      expect(f.map((x: F) => x.classification), loc).toEqual(["candidate"]);
    }
  });
  it("a value a named rule already reported on the line is not repeated by the generic rule", () => {
    const f = scanText(join("NEXTAUTH", "_SECRET=", rnd(40), "\n"), ".env");
    expect(f.map((x: F) => x.rule)).toEqual(["secret-env-assignment"]);
  });
});
