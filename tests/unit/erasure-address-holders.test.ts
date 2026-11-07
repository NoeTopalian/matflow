/**
 * lib/erasure-address-holders.ts — whether an address-keyed Activity row may be repointed to the erased member:
 * only when no other member of the club ever held the address, in any form the club has written (7 Nov 2026).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { addressDigestForms, addressHolders, decideAddressRow } from "@/lib/erasure-address-holders";
import { emailDigest } from "@/lib/login-email";
import { hashToken } from "@/lib/token-hash";
import type { ErasureSubject } from "@/lib/importers/import-erasure";

const FAY: ErasureSubject = { memberId: "m_fay", sourceKey: null, email: "fay.dunn@example.test", name: "Fay Dunn", addressDigest: (a) => emailDigest(a) };

describe("addressDigestForms", () => {
  it("an address with capitals: the keyed and unkeyed digests of the lower-cased address, and the hashToken of both the lower-cased and the stored address", () => {
    const forms = addressDigestForms(" Fay.Dunn@Example.test ");
    expect(forms[0]).toBe(emailDigest("fay.dunn@example.test"));
    expect(forms).toContain(createHash("sha256").update("fay.dunn@example.test").digest("hex"));
    expect(forms).toContain(hashToken("fay.dunn@example.test"));
    expect(forms).toContain(hashToken("Fay.Dunn@Example.test"));
    expect(forms).toHaveLength(4);
    // An address already lower-case has three distinct forms.
    expect(addressDigestForms("fay.dunn@example.test")).toHaveLength(3);
  });
});

describe("decideAddressRow", () => {
  it("only the subject ever held it: repoint", () => {
    const holders = addressHolders([{ id: "m_fay", email: "fay.dunn@example.test", unverifiedEmail: null }, { id: "m_ben", email: "ben@example.test", unverifiedEmail: null }], []);
    expect(decideAddressRow("Fay.Dunn@Example.test", FAY, holders)).toBe("repoint");
  });

  it("an erased member's fulfilment row written before 7 Nov 2026 (hashToken of the address as stored, with capitals): neutral", () => {
    const holders = addressHolders(
      [{ id: "m_fay", email: "fay.dunn@example.test", unverifiedEmail: null }],
      [{ entityId: "m_gone", metadata: { originalEmailHash: hashToken("Fay.Dunn@Example.test") } }],
    );
    expect(decideAddressRow("Fay.Dunn@Example.test", FAY, holders)).toBe("neutral");
  });

  it("the same, written since 7 Nov 2026 (hashToken of the lower-cased address): neutral, whatever the row's case", () => {
    const holders = addressHolders(
      [{ id: "m_fay", email: "fay.dunn@example.test", unverifiedEmail: null }],
      [{ entityId: "m_gone", metadata: { originalEmailHash: hashToken("fay.dunn@example.test") } }],
    );
    expect(decideAddressRow("FAY.DUNN@EXAMPLE.TEST", FAY, holders)).toBe("neutral");
  });

  it("another member's earlier address (keyed, unkeyed or a release list) makes it neutral", () => {
    const keyed = addressHolders([], [{ entityId: "m_eve", metadata: { oldEmailSha256: emailDigest("fay.dunn@example.test") } }]);
    const unkeyed = addressHolders([], [{ entityId: "m_eve", metadata: { oldEmailSha256: createHash("sha256").update("fay.dunn@example.test").digest("hex") } }]);
    const list = addressHolders([], [{ entityId: "m_eve", metadata: { releasedEmailSha256: ["x", emailDigest("fay.dunn@example.test")] } }]);
    for (const h of [keyed, unkeyed, list]) expect(decideAddressRow("fay.dunn@example.test", FAY, h)).toBe("neutral");
  });

  it("an address the subject never held: left alone", () => {
    const holders = addressHolders([{ id: "m_ben", email: "ben@example.test", unverifiedEmail: null }], []);
    expect(decideAddressRow("ben@example.test", FAY, holders)).toBeNull();
  });

  it("an earlier address of the subject's own, recorded only by their change row: theirs (repoint when no one else held it)", () => {
    const holders = addressHolders([], [{ entityId: "m_fay", metadata: { oldEmailSha256: emailDigest("fay.old@example.test") } }]);
    expect(decideAddressRow("Fay.Old@example.test", FAY, holders)).toBe("repoint");
  });
});
