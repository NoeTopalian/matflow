import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = {};
  out.envHas = {
    NEXTAUTH_SECRET: !!process.env.NEXTAUTH_SECRET,
    AUTH_SECRET: !!process.env.AUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? null,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST ?? null,
    DATABASE_URL: !!process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_RUNTIME: process.env.NEXT_RUNTIME,
    VERCEL_URL: process.env.VERCEL_URL ?? null,
  };

  try {
    const mod = await import("@/auth");
    out.authImported = true;
    out.handlersGet = typeof mod.handlers?.GET;
    out.handlersPost = typeof mod.handlers?.POST;
  } catch (e) {
    out.authImportError = e instanceof Error ? { message: e.message, stack: e.stack } : String(e);
  }

  try {
    const { handlers } = await import("@/auth");
    const csrfReq = new Request("https://example.com/api/auth/csrf", { method: "GET" });
    const res = await handlers.GET(csrfReq);
    out.csrfStatus = res.status;
    out.csrfBody = await res.text();
  } catch (e) {
    out.csrfHandlerError = e instanceof Error ? { message: e.message, stack: e.stack } : String(e);
  }

  return NextResponse.json(out);
}
