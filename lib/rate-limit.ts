import { prisma } from "@/lib/prisma";

const memoryStore = new Map<string, { count: number; resetAt: number }>();

async function checkDbRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const cutoff = new Date(Date.now() - windowMs);
  const count = await prisma.rateLimitHit.count({ where: { bucket, hitAt: { gte: cutoff } } });
  if (count >= max) {
    const oldest = await prisma.rateLimitHit.findFirst({
      where: { bucket, hitAt: { gte: cutoff } },
      orderBy: { hitAt: "asc" },
    });
    const resetAt = oldest ? oldest.hitAt.getTime() + windowMs : Date.now() + windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
  }
  await prisma.rateLimitHit.create({ data: { bucket } });
  if (Math.random() < 0.05) {
    const pruneCutoff = new Date(Date.now() - 60 * 60 * 1000);
    prisma.rateLimitHit.deleteMany({ where: { hitAt: { lt: pruneCutoff } } }).catch(() => {});
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function checkMemoryRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = memoryStore.get(bucket);
  if (!entry || now >= entry.resetAt) {
    memoryStore.set(bucket, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function checkRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  let result: { allowed: boolean; retryAfterSeconds: number };
  try {
    result = await checkDbRateLimit(bucket, max, windowMs);
  } catch {
    result = checkMemoryRateLimit(bucket, max, windowMs);
  }
  // Surface every rate-limit hit so they show up in Vercel logs + Sentry.
  // Without this, attacks against /api/auth/* or /api/apply are silent.
  if (!result.allowed) {
    console.warn(
      `[rate-limit] bucket=${bucket} max=${max} windowMs=${windowMs} ` +
        `retryAfter=${result.retryAfterSeconds}s`,
    );
  }
  return result;
}

export async function resetRateLimit(bucket: string) {
  memoryStore.delete(bucket);
  try {
    await prisma.rateLimitHit.deleteMany({ where: { bucket } });
  } catch { /* ignore */ }
}

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() ?? "unknown";
}
