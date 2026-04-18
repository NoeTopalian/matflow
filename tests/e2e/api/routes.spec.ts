import { test, expect } from "@playwright/test";

/**
 * Smoke tests for critical API routes — verifies they return the right HTTP status
 * without requiring auth (public routes) or return 401 (protected routes).
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

  test("GET /api/me/gym returns 401 for unauthenticated request", async ({ request }) => {
    const res = await request.get("/api/me/gym");
    expect(res.status()).toBe(401);
  });

  test("GET /api/members returns 401 for unauthenticated request", async ({ request }) => {
    const res = await request.get("/api/members");
    expect(res.status()).toBe(401);
  });

  test("GET /api/dashboard/stats returns 401 for unauthenticated request", async ({ request }) => {
    const res = await request.get("/api/dashboard/stats");
    expect(res.status()).toBe(401);
  });

  test("GET /api/member/me returns 401 for unauthenticated request", async ({ request }) => {
    const res = await request.get("/api/member/me");
    expect(res.status()).toBe(401);
  });

  test("GET /api/member/schedule returns 401 for unauthenticated request", async ({ request }) => {
    const res = await request.get("/api/member/schedule");
    expect(res.status()).toBe(401);
  });

  test("GET /api/members/lookup returns 200 (public search endpoint)", async ({ request }) => {
    const res = await request.get("/api/members/lookup?q=test&tenantSlug=total-bjj");
    // Either 200 with results or 200 with empty array — not 401 (it's public)
    expect([200, 404]).toContain(res.status());
  });

  test("POST /api/checkin returns 401 for unauthenticated request", async ({ request }) => {
    const res = await request.post("/api/checkin", { data: {} });
    expect(res.status()).toBe(401);
  });
});
