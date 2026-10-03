/**
 * Browser half of the chunked import upload (server: lib/import-upload.ts,
 * routes under app/api/admin/import/uploads). Browser-safe: no node imports.
 *
 * Hashes the whole file (sha256, Web Crypto), opens an upload, PUTs each
 * chunk with `file.slice`, retrying a failed chunk up to 3 times with backoff,
 * then asks the server to verify size and hash. Returns the reference the
 * import API claims. A refusal throws an Error carrying the server's `error`.
 */

export type UploadPhase = "hashing" | "uploading" | "verifying";
export type UploadProgress = { sentBytes: number; totalBytes: number; phase: UploadPhase };

const BASE = "/api/admin/import/uploads";
const CHUNK_RETRIES = 3;
const BACKOFF_MS = 500;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON (e.g. a platform error page).
  }
  return `Upload failed (${res.status})`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Worth another attempt: the network dropped, the server faulted, or it asked us to slow down. */
function retryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export async function uploadFileInChunks(
  file: File,
  opts: { purpose: string; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal },
): Promise<{ uploadId: string; sha256: string; bytes: number }> {
  const { purpose, onProgress, signal } = opts;
  const totalBytes = file.size;

  onProgress?.({ sentBytes: 0, totalBytes, phase: "hashing" });
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  signal?.throwIfAborted();

  const created = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose, fileName: file.name, bytes: totalBytes, sha256 }),
    signal,
  });
  if (!created.ok) throw new Error(await errorText(created));
  const { uploadId, token, chunkSize, chunkCount } = (await created.json()) as {
    uploadId: string;
    token: string;
    chunkSize: number;
    chunkCount: number;
  };

  let sentBytes = 0;
  onProgress?.({ sentBytes, totalBytes, phase: "uploading" });
  for (let index = 0; index < chunkCount; index++) {
    const chunk = file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, totalBytes));
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(`${BASE}/${encodeURIComponent(uploadId)}/chunks/${index}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "x-upload-token": token },
          body: chunk,
          signal,
        });
      } catch (e) {
        // A network failure is retried; an abort is not.
        if (signal?.aborted || attempt >= CHUNK_RETRIES) throw e;
      }
      if (res?.ok) break;
      if (res && (!retryable(res.status) || attempt >= CHUNK_RETRIES)) throw new Error(await errorText(res));
      await wait(BACKOFF_MS * 2 ** attempt, signal);
    }
    sentBytes += chunk.size;
    onProgress?.({ sentBytes, totalBytes, phase: "uploading" });
  }

  onProgress?.({ sentBytes, totalBytes, phase: "verifying" });
  const done = await fetch(`${BASE}/${encodeURIComponent(uploadId)}/complete`, {
    method: "POST",
    headers: { "x-upload-token": token },
    signal,
  });
  if (!done.ok) throw new Error(await errorText(done));

  return { uploadId, sha256, bytes: totalBytes };
}
