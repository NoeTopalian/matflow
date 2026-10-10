/**
 * The contexts under which a SUB-KEY is derived from the root secret as HMAC(root, context) (R6-N2, lane A4).
 *
 * A sub-key is only separate from the root's other uses if no other code path ever computes HMAC(root, x) for
 * x = a context and shows the result to anyone. POST /api/account/pending-tenant did exactly that (its cookie was
 * HMAC(root, slug), and a Tenant slug can be any string a raw INSERT writes), so it now signs with its own sub-key
 * over a prefixed message, and lib/token-hash refuses to MAC a registered context verbatim.
 *
 * The derivations themselves are deliberately UNCHANGED (lib/attendance-import, lib/kiosk-token and lib/card-token
 * still compute HMAC(root, context) inline, byte-identical): printed member cards live for years and must keep
 * verifying. tests/unit/sec-a4-subkey-separation.test.ts pins fixed-key vectors for all three and scans the code base
 * so every `createHmac("sha256", AUTH_SECRET_VALUE).update(<X>_CONTEXT)` names a context registered here.
 *
 * Its own module (not lib/auth-secret) because several unit tests replace lib/auth-secret wholesale with a bare
 * { AUTH_SECRET_VALUE }; anything exported next to it would be undefined under those mocks. Deliberately free of
 * imports, so lib/token-hash can use it anywhere.
 *
 * Every context has the shape matflow.<name>[.<part>].v<N>: no ':', '|' or '@' and a non-numeric last segment —
 * shapes the remaining raw signers (Drive / Stripe Connect state, device hash, disown token, operator session) can
 * never produce. Add a new derivation here, in that shape, or the registry test fails.
 */
export const ROOT_KEY_CONTEXTS: readonly string[] = Object.freeze([
  "matflow.import-mapping-provenance.v2",
  "matflow.kiosk.v1",
  "matflow.card.v1",
  "matflow.pending-tenant-cookie.v1",
]);

export function isRootKeyContext(value: string): boolean {
  return ROOT_KEY_CONTEXTS.includes(value);
}
