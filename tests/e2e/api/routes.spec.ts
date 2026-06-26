import { test, expect } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

/**
 * Smoke tests for critical API routes — verifies they return the right HTTP status
 * without requiring auth (public routes) or return 401 (protected routes).
 *
 * NOTE: The chromium/Mobile Chrome projects inject owner storageState into the
 * `request` fixture, so unauthenticated assertions must use a fresh context with
 * empty storage state to avoid the owner cookie being sent.
 */
test.describe("API route smoke tests", () => {
  test("GET /api/member/products returns 200 with products", async ({ request }) => {
    const res = await request.get("/api/member/products");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("price");
  });

  test("GET /api/me/gym returns 401 for unauthenticated request", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/me/gym`);
    // Protected: either a direct 401/403, or the auth middleware redirected
    // the unauthenticated request to /login (307 → followed to the login page).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });

  test("GET /api/members returns 401 for unauthenticated request", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/members`);
    // Protected: either a direct 401/403, or the auth middleware redirected
    // the unauthenticated request to /login (307 → followed to the login page).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });

  test("GET /api/dashboard/stats returns 401 for unauthenticated request", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/dashboard/stats`);
    // Protected: either a direct 401/403, or the auth middleware redirected
    // the unauthenticated request to /login (307 → followed to the login page).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });

  test("GET /api/member/me returns 401 for unauthenticated request", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/member/me`);
    // Protected: either a direct 401/403, or the auth middleware redirected
    // the unauthenticated request to /login (307 → followed to the login page).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });

  test("GET /api/member/schedule returns 401 for unauthenticated request", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/member/schedule`);
    // Protected: either a direct 401/403, or the auth middleware redirected
    // the unauthenticated request to /login (307 → followed to the login page).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });

  test("POST /api/checkin returns 401 for unauthenticated request", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.post(`${BASE}/api/checkin`, { data: {} });
    // Protected: either a direct 401/403, or the auth middleware redirected
    // the unauthenticated request to /login (307 → followed to the login page).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });
});
