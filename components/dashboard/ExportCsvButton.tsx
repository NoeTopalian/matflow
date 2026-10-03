"use client";

/**
 * Downloads the payments CSV and says so on screen when it cannot.
 *
 * It used to be a Next <Link> to the API route: the Link PREFETCHED on every
 * view of the Payments page, so merely opening the page ran the 5,000-row
 * export and spent the 10-an-hour export allowance, and when the allowance ran
 * out the owner was dropped on the bare API URL showing raw JSON (verifier
 * lane 4, 30 Sep 2026). A button that fetches on click spends nothing on a
 * view and keeps any refusal inside the product.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api-field-errors";

/**
 * What the owner is told when the server cut the file at its row cap. Null when
 * nothing was cut. Exported for the unit test.
 */
export function exportCapNotice(headers: Pick<Headers, "get">): string | null {
  if (headers.get("X-Rows-Truncated") !== "true") return null;
  const cap = Number(headers.get("X-Row-Cap"));
  const n = Number.isFinite(cap) && cap > 0 ? cap.toLocaleString("en-GB") : "the maximum number of";
  return `This file holds the newest ${n} payments only. Older payments are not in it.`;
}

export default function ExportCsvButton({ href = "/api/payments/export.csv" }: { href?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(href);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const wait = Number(res.headers.get("Retry-After"));
        setError(
          res.status === 429
            ? `You've exported several times in the last hour. Try again${wait > 0 ? ` in about ${Math.ceil(wait / 60)} minute${Math.ceil(wait / 60) === 1 ? "" : "s"}` : " shortly"}.`
            : describeApiError(body),
        );
        return;
      }
      const blob = await res.blob();
      const name = /filename="?([^";]+)"?/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "matflow-payments.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // The export is capped (newest first). When the cap cut rows off, say so
      // — the file alone cannot tell the owner what is missing from it.
      const notice = exportCapNotice(res.headers);
      if (notice) setNotice(notice);
    } catch {
      setError("Couldn't reach MatFlow to export. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant="secondary" size="compact" onClick={() => void download()} disabled={busy}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
        Export CSV
      </Button>
      {error && (
        <span role="alert" className="max-w-[260px] text-right text-xs" style={{ color: "var(--hue-danger-ink)" }}>
          {error}
        </span>
      )}
      {notice && (
        <span role="status" className="max-w-[260px] text-right text-xs" style={{ color: "var(--hue-warning-ink)" }}>
          {notice}
        </span>
      )}
    </span>
  );
}
