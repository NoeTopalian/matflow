/**
 * The explicit link between an external identity (provider + the provider's
 * stable subject id) and ONE account in ONE club — SF-36.
 *
 * Created only by the account itself, signed in and re-proving its password or
 * authenticator; never derived from a matching email address. The table that
 * holds links (ExternalIdentity) is a proposed migration
 * (docs/security/evidence/A2/SF-36-google-linking-proposal.md); until it
 * exists there are no links, and the Google door refuses everyone.
 *
 * Its own module (lane A3, 9 Oct 2026) so it is the single seam the store lands
 * in, and so tests can stand a link up and drive the rest of the Google path
 * (the login event's client IP, the token hydration) that the interim refusal
 * otherwise makes unreachable. When the store lands, the lookup is by
 * (tenantId, provider, providerSubject) ONLY — never by email — and it runs
 * BEFORE any account is looked up by address (see the proposal, "Lookup").
 */
export async function linkedExternalIdentity(
  _provider: "google",
  _providerSubject: string | undefined,
  _tenantId: string,
): Promise<{ userId?: string; memberId?: string } | null> {
  return null;
}
