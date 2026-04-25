import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { createHmac } from "crypto";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.STRIPE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "Stripe Connect not configured" }, { status: 503 });
  }

  const timestamp = Date.now();
  const payload = `${session.user.tenantId}:${timestamp}`;
  const state = createHmac("sha256", process.env.NEXTAUTH_SECRET!)
    .update(payload)
    .digest("hex") + `:${payload}`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "read_write",
    state,
  });

  return NextResponse.json({ url: `https://connect.stripe.com/oauth/authorize?${params}` });
}
