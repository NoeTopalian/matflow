import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { PRODUCTS } from "@/lib/products";

/**
 * GET /api/member/products — products visible to the logged-in member's tenant.
 *
 * Reads from the Product table (B9). Falls back to the static lib/products.ts
 * catalogue only when:
 *  - the member is on the demo tenant, or
 *  - the tenant has no Product rows yet (graceful onboarding default).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenantId = session.user.tenantId;

  if (tenantId === "demo-tenant") {
    return NextResponse.json(PRODUCTS);
  }

  try {
    const rows = await withTenantContext(tenantId, (tx) =>
      tx.product.findMany({
        where: { tenantId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      }),
    );

    if (rows.length === 0) {
      // Tenant hasn't customised the store yet — show the default catalogue
      // so the member shop isn't empty on a fresh install.
      return NextResponse.json(PRODUCTS);
    }

    return NextResponse.json(
      rows.map((p) => ({
        id: p.id,
        name: p.name,
        // Member shop expects price in major units (£25, not 2500p) for display.
        price: p.pricePence / 100,
        category: p.category,
        inStock: p.inStock,
        symbol: p.symbol ?? "🛍️",
        description: p.description ?? "",
      })),
    );
  } catch {
    return NextResponse.json(PRODUCTS);
  }
}
