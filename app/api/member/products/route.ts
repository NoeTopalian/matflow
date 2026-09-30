import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { PRODUCTS } from "@/lib/products";

/**
 * GET /api/member/products — products visible to the logged-in member's tenant.
 *
 * Reads from the Product table (B9). The static lib/products.ts catalogue is
 * served only to the demo tenant. A real club with no products gets an empty
 * list: the old "default catalogue" showed members a T-shirt, rashguard and
 * snacks the gym never listed and took pay-at-desk orders for them (verifier
 * lane 2, 30 Sep 2026; UI-RULES §7, no fabricated data).
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
  } catch (err) {
    // Serving the static catalogue on a DB ERROR would be fiction the client
    // cannot tell from failure. Surface the failure honestly instead.
    console.error("[member/products] GET failed", err);
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
}
