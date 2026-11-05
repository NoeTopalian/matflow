// Shared, import-free state for the operator-hub database suites: the cookie
// jar the mocked next/headers reads, and the staff session the mocked @/auth
// returns. Import-free on purpose: a test file's vi.mock factories load it
// with a dynamic import, which must not pull in anything those mocks replace.

export const hubState: { jar: Map<string, string>; session: null | Record<string, unknown> } = {
  jar: new Map<string, string>(),
  session: null,
};
