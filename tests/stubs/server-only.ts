// `server-only` is a marker package with no runtime: Next's bundler fails the BUILD when a client component imports a
// module that imports it. Under vitest there is no bundler and the package is not installed (Next carries its own
// copy), so vitest.config.ts points the name here. The real guard stays the build; tests/unit/activity-feed-lookups
// also checks that nothing under components/ imports the server module.
export {};
