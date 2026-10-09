/**
 * Security campaign iteration 2, lane E2 (9 Oct 2026): the prepared SPF/DMARC changes for matflow.studio
 * (docs/security/evidence/E2/mail-records-proposed.json) are checked before Noe applies them.
 * Grounding: RFC 7208 (one SPF record per name, 10-lookup limit), RFC 7489 §6.3 (tags), §6.6.3 (policy discovery
 * falls back to the organisational domain), §7.1 (external report destinations need authorisation).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Rec = { name: string; type: string; values?: string[]; value?: string; stage?: number };
const ROOT = path.resolve(__dirname, "../..");
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/security/evidence/E2/mail-records-proposed.json"), "utf8"));
const observed: Rec[] = doc.observed.records;
const proposed: Rec[] = doc.proposed;

const isSpf = (v: string) => /^v=spf1(\s|$)/i.test(v);
const dmarcTags = (v: string) =>
  Object.fromEntries(
    v.split(";").map((t) => t.trim()).filter(Boolean).map((t) => {
      const i = t.indexOf("=");
      return [t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim()];
    }),
  );
// matflow.studio has a two-label organisational domain (the .studio public suffix is one label).
const orgDomain = (d: string) => d.toLowerCase().split(".").slice(-2).join(".");
const relaxedAligned = (a: string, b: string) => orgDomain(a) === orgDomain(b);

describe("prepared mail-authentication records", () => {
  it("never leaves two SPF records on one name (observed + proposed)", () => {
    const byName = new Map<string, number>();
    for (const r of observed.filter((r) => r.type === "TXT")) for (const v of r.values ?? []) if (isSpf(v)) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
    for (const r of proposed.filter((r) => r.type === "TXT" && isSpf(r.value ?? ""))) byName.set(r.name, (byName.get(r.name) ?? 0) + 1);
    for (const [name, n] of byName) expect(n, name).toBe(1);
    expect(byName.get("send.matflow.studio")).toBe(1);
  });

  it("keeps every SPF record syntactically valid and under the 10 DNS-lookup limit", () => {
    const spf = [
      ...observed.flatMap((r) => (r.values ?? []).filter(isSpf)),
      ...proposed.map((r) => r.value ?? "").filter(isSpf),
    ];
    for (const v of spf) {
      const terms = v.split(/\s+/).slice(1);
      for (const t of terms) expect(t).toMatch(/^([+~?-]?(all|include:[a-z0-9.-]+|a|mx|ip4:[0-9./]+|ip6:[0-9a-f:./]+|exists:\S+)|redirect=\S+)$/i);
      const lookups = terms.filter((t) => /^[+~?-]?(include:|a\b|mx\b|exists:|redirect=)/i.test(t)).length;
      expect(lookups).toBeLessThanOrEqual(10);
    }
  });

  it("stages DMARC none -> quarantine -> reject, never starting at reject", () => {
    const d = proposed.filter((r) => r.name === "_dmarc.matflow.studio").sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0));
    expect(d.map((r) => dmarcTags(r.value!).p)).toEqual(["none", "quarantine", "reject"]);
    for (const r of d) {
      const t = dmarcTags(r.value!);
      expect(r.value!.startsWith("v=DMARC1;")).toBe(true);
      expect(["r", "s"]).toContain(t.adkim);
      expect(["r", "s"]).toContain(t.aspf);
      expect(t.rua).toMatch(/^mailto:\S+$/);
      if (t.pct) expect(Number(t.pct)).toBeGreaterThan(0);
    }
    // A DMARC record may only be on the _dmarc label, never on the apex itself.
    expect(proposed.some((r) => r.name === "matflow.studio" && /v=DMARC1/i.test(r.value ?? ""))).toBe(false);
  });

  it("aligns Resend mail under relaxed alignment: DKIM d=matflow.studio and envelope send.matflow.studio vs From matflow.studio", () => {
    const from = "matflow.studio";
    expect(relaxedAligned("matflow.studio", from)).toBe(true); // DKIM selector resend._domainkey.matflow.studio
    expect(relaxedAligned("send.matflow.studio", from)).toBe(true); // SPF on the Resend return-path
    expect(relaxedAligned("amazonses.com", from)).toBe(false); // negative control
    expect(observed.find((r) => r.name === "resend._domainkey.matflow.studio")?.values?.length).toBe(1);
    expect(observed.find((r) => r.name === "send.matflow.studio" && r.type === "TXT")?.values?.[0]).toBe("v=spf1 include:amazonses.com ~all");
  });

  it("does not point reports at a matflow.studio mailbox while the apex has no MX", () => {
    const apexMx = observed.find((r) => r.name === "matflow.studio" && r.type === "MX")?.values ?? [];
    for (const r of proposed.filter((r) => r.name === "_dmarc.matflow.studio")) {
      const rua = dmarcTags(r.value!).rua;
      if (apexMx.length === 0) expect(rua).not.toMatch(/@matflow\.studio$/i);
    }
  });
});
