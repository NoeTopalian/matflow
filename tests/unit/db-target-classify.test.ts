import { describe, it, expect } from "vitest";
import { classifyDbTarget, assertTestBranch, skipReason } from "../integration/helpers/db-target";

const neon = (id: string) => `postgresql://u:p@${id}-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`;

describe("classifyDbTarget (URL strings only, no connection)", () => {
  it("TEST branch runs", () => {
    expect(classifyDbTarget(neon("ep-hidden-salad-abom7cg4"))).toBe("run");
    expect(classifyDbTarget("postgresql://u:p@ep-hidden-salad-x.eu-west-2.aws.neon.tech/neondb")).toBe("run");
  });
  it("local and CI targets skip", () => {
    for (const u of [
      "postgresql://postgres:postgres@localhost:5432/postgres?schema=public",
      "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      "postgresql://postgres:postgres@[::1]:5432/postgres",
      "postgresql://postgres:postgres@postgres:5432/postgres",
    ]) expect(classifyDbTarget(u), u).toBe("skip");
    expect(skipReason("skip")).toMatch(/needs the Neon TEST branch/);
  });
  it("production and every other remote host are refused", () => {
    expect(classifyDbTarget(neon("ep-bold-wave-abt39t7x"))).toBe("refuse");
    expect(classifyDbTarget("postgresql://u:p@foo.neon.tech/neondb")).toBe("refuse");
    expect(classifyDbTarget(neon("ep-other-thing-123"))).toBe("refuse");
    expect(classifyDbTarget("postgresql://u:p@db.example.com:5432/x")).toBe("refuse");
    expect(classifyDbTarget("postgresql://u:p@10.0.0.5:5432/x")).toBe("refuse");
    expect(classifyDbTarget("not a url")).toBe("refuse");
  });
  it("a test-looking name cannot launder the wrong host, and production anywhere refuses", () => {
    expect(classifyDbTarget("postgresql://u:p@ep-hidden-salad.example.com/x")).toBe("refuse");
    expect(classifyDbTarget("postgresql://u:p@localhost.evil.com/x")).toBe("refuse");
    expect(classifyDbTarget(`postgresql://u:endpoint=ep-bold-wave$not-a-real-pw@${"ep-hidden-salad-x"}.eu-west-2.aws.neon.tech/x`)).toBe("refuse");
    expect(classifyDbTarget("postgresql://u:p@localhost/ep-bold-wave")).toBe("refuse");
  });
  it("no URL is none; assertTestBranch throws unless run", () => {
    expect(classifyDbTarget(undefined)).toBe("none");
    expect(classifyDbTarget("")).toBe("none");
    expect(() => assertTestBranch(neon("ep-hidden-salad-abom7cg4"))).not.toThrow();
    expect(() => assertTestBranch(neon("ep-bold-wave-abt39t7x"))).toThrow(/REFUSED/);
    expect(() => assertTestBranch("postgresql://u:p@localhost/x")).toThrow(/REFUSED/);
  });
});
