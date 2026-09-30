// The local-file fallback for import CSVs exists only so a rehearsal can run
// the real upload → preview → commit path without a Blob token. It must never
// be reachable in production, whatever TESTING_MODE says.

import { describe, it, expect, afterEach, vi } from "vitest";
import { importStorageAvailable, putImportFile, readImportFile, deleteImportFile, sha256 } from "@/lib/import-storage";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

function envWith(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("import storage", () => {
  it("has no storage without a Blob token outside a testing environment", () => {
    envWith({ BLOB_READ_WRITE_TOKEN: undefined, TESTING_MODE: undefined, VERCEL_ENV: undefined });
    expect(importStorageAvailable()).toBe(false);
  });

  it("never falls back to local files in production, even with TESTING_MODE on", async () => {
    envWith({ BLOB_READ_WRITE_TOKEN: undefined, TESTING_MODE: "true", VERCEL_ENV: "production" });
    expect(importStorageAvailable()).toBe(false);
    await expect(putImportFile("t1", new TextEncoder().encode("a,b"))).rejects.toThrow(/not configured/);
    await expect(readImportFile("local-import://t1-x.csv")).rejects.toThrow(/not available/);
  });

  it("round-trips a file locally in a testing environment and deletes it", async () => {
    envWith({ BLOB_READ_WRITE_TOKEN: undefined, TESTING_MODE: "true", VERCEL_ENV: undefined });
    const url = await putImportFile("t1", new TextEncoder().encode("Customer Name\nAda"));
    expect(url.startsWith("local-import://")).toBe(true);
    expect(await readImportFile(url)).toBe("Customer Name\nAda");
    await deleteImportFile(url);
    expect(await readImportFile(url)).toBeNull();
  });

  it("cannot be steered outside its directory by a crafted url", async () => {
    envWith({ BLOB_READ_WRITE_TOKEN: undefined, TESTING_MODE: "true", VERCEL_ENV: undefined });
    expect(await readImportFile("local-import://../../../../etc/hosts")).toBeNull();
  });

  it("hashes bytes deterministically", () => {
    const a = sha256(new TextEncoder().encode("same"));
    expect(a).toBe(sha256(new TextEncoder().encode("same")));
    expect(a).not.toBe(sha256(new TextEncoder().encode("same\n")));
    expect(a).toHaveLength(64);
  });
});
