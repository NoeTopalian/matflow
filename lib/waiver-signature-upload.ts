import { put } from "@vercel/blob";
import { randomBytes } from "crypto";

/**
 * Stores a PNG signature for a tenant. Returns either a Vercel Blob URL
 * (when BLOB_READ_WRITE_TOKEN is set AND the upload succeeds) OR a
 * data:image/png;base64,... URL fallback. Both forms are valid values
 * for SignedWaiver.signatureImageUrl; the proxy at
 * /api/waiver/[signedWaiverId]/signature handles both transparently.
 *
 * Rationale: prod Vercel Blob has historically been unreliable (token
 * 500s noted in CLAUDE.md). Without this fallback, every waiver-signing
 * route returns 503 the moment Blob is down — which kills new-member
 * onboarding, parent kid-waiver flow, and staff-supervised collection
 * simultaneously. Data-URL fallback keeps signatures legally captured
 * even when storage is degraded.
 */
export async function uploadSignatureWithFallback(png: Buffer, tenantId: string): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const cuid = randomBytes(12).toString("hex");
      const blob = await put(
        `tenants/${tenantId}/signatures/${cuid}.png`,
        png as unknown as Blob,
        { access: "public", contentType: "image/png", addRandomSuffix: true },
      );
      return blob.url;
    } catch {
      // Fall through to data: URL — Blob is configured but transiently unavailable.
    }
  }
  return `data:image/png;base64,${png.toString("base64")}`;
}
