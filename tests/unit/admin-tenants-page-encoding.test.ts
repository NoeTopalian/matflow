import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("app/admin/tenants/page.tsx encoding (review L7)", () => {
  const bytes = readFileSync(join(process.cwd(), "app/admin/tenants/page.tsx"));
  it("has no UTF-8 byte-order mark", () => {
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });
  it("has no mojibake from a re-encode", () => {
    expect(bytes.toString("utf8")).not.toContain("â€");
  });
});
