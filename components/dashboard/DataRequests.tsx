"use client";

/**
 * Settings → Data requests (PR 3, 6 Nov 2026). The owner's one place to answer
 * a formal UK GDPR request: a copy of someone's data (subject access) or the
 * erasure of their personal data. Noe: "only the owner can delete specific
 * user data under request and this should appear under settings of owner".
 *
 * It reuses the existing owner-only routes unchanged:
 *   GET  /api/admin/dsar/export?memberId=…   (the JSON file)
 *   POST /api/admin/dsar/erase?memberId=…    (probe=1 first; strategy=cascade
 *                                              when they are a child's guardian)
 * and finds people through GET /api/admin/dsar/subjects, which includes
 * archived members: removing a member archives them, and erasing an archived
 * member must work. Erasure is the only true delete in MatFlow.
 */
import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/date";

type Subject = {
  id: string;
  name: string;
  email: string;
  status: string;
  accountType: string;
  archivedAt: string | null;
  joinedAt: string;
  erased: boolean;
};

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

export default function DataRequests({ initialMemberId }: { initialMemberId: string | null }) {
  const { toast } = useToast();
  const { ask, dialogProps } = useConfirmDialog();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Subject[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Subject | null>(null);
  const [children, setChildren] = useState<number | null>(null);
  const [eraseChildren, setEraseChildren] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const pick = useCallback(async (s: Subject) => {
    setSelected(s);
    setChildren(null);
    setEraseChildren(false);
    setActionError(null);
    if (s.erased) return;
    try {
      const res = await fetch(`/api/admin/dsar/erase?memberId=${encodeURIComponent(s.id)}&probe=1`, { method: "POST" });
      if (!res.ok) {
        setActionError(await readError(res, "Couldn't check this member's child accounts. Try again."));
        return;
      }
      const data = (await res.json()) as { activeChildren?: number };
      setChildren(data.activeChildren ?? 0);
    } catch {
      setActionError("Couldn't reach MatFlow. Check your connection and try again.");
    }
  }, []);

  // The old member-profile link forwards here with ?member=<id> already picked.
  useEffect(() => {
    if (!initialMemberId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/dsar/subjects?id=${encodeURIComponent(initialMemberId)}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setSearchError(await readError(res, "Couldn't open that member. Search for them below."));
          return;
        }
        const rows = (await res.json()) as Subject[];
        if (rows[0]) void pick(rows[0]);
        else setSearchError("That member isn't in this club. Search for them below.");
      } catch {
        if (!cancelled) setSearchError("Couldn't reach MatFlow. Search for the member below.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialMemberId, pick]);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (query.trim().length < 2) {
      setSearchError("Type at least 2 characters of a name or email.");
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`/api/admin/dsar/subjects?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
      if (!res.ok) {
        setResults(null);
        setSearchError(await readError(res, "Couldn't search members. Try again."));
        return;
      }
      setResults((await res.json()) as Subject[]);
    } catch {
      setResults(null);
      setSearchError("Couldn't reach MatFlow. Check your connection and try again.");
    } finally {
      setSearching(false);
    }
  }

  async function doExport() {
    if (!selected) return;
    setExporting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/dsar/export?memberId=${encodeURIComponent(selected.id)}`);
      if (!res.ok) {
        setActionError(await readError(res, `Export failed (${res.status}). Try again.`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `matflow-data-request-${selected.id}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Export downloaded", "success");
    } catch {
      setActionError("Couldn't reach MatFlow. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  async function doErase() {
    if (!selected) return;
    const first = await ask({
      title: `Erase ${selected.name}'s personal data?`,
      body: eraseChildren
        ? "Only do this to fulfil a formal erasure request. Their name, contact details and stored documents are removed and they are marked cancelled; their visits and payments stay as anonymous records, and a record of the erasure is kept. The child accounts they are guardian for are deleted entirely, including their visits, belts and class packs. This cannot be undone."
        : "Only do this to fulfil a formal erasure request. Their name, contact details and stored documents are removed and they are marked cancelled, so they leave the active count. Their visits and payments stay as anonymous records, and a record of the erasure is kept. This cannot be undone.",
      confirmLabel: "Continue",
      destructive: true,
    });
    if (!first) return;
    const second = await ask({
      title: "Final confirmation",
      body: "Once you confirm, the personal data is gone permanently. It cannot be recovered from a backup or restored by support.",
      confirmLabel: "Erase permanently",
      cancelLabel: "Keep the data",
      destructive: true,
    });
    if (!second) return;
    setErasing(true);
    setActionError(null);
    try {
      const strategy = children && children > 0 ? "&strategy=cascade" : "";
      const res = await fetch(`/api/admin/dsar/erase?memberId=${encodeURIComponent(selected.id)}${strategy}`, { method: "POST" });
      if (!res.ok) {
        setActionError(await readError(res, `Erasure failed (${res.status}). Nothing was erased. Try again.`));
        return;
      }
      toast("Personal data erased", "success");
      setSelected({ ...selected, name: "Deleted member", email: "", erased: true });
      setResults(null);
    } catch {
      setActionError("Couldn't reach MatFlow. The erasure may not have happened. Search for the member again to check.");
    } finally {
      setErasing(false);
    }
  }

  const needsChildChoice = (children ?? 0) > 0;

  return (
    <div className="space-y-4" data-testid="data-requests">
      <div className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-5">
        <h2 className="text-base font-semibold text-tx-1">Data requests</h2>
        <p className="mt-1 text-sm text-tx-3">
          For a formal request under UK GDPR from a member, or a parent on a child&rsquo;s behalf: a copy of the data MatFlow holds
          about them, or the erasure of their personal data. Removing someone from Members archives them and keeps their records;
          erasure here is the only way personal data is deleted.
        </p>
        <form onSubmit={search} className="mt-4 flex gap-2" role="search">
          <Input
            aria-label="Find a member by name or email"
            placeholder="Name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="secondary" loading={searching}>
            <Search className="h-4 w-4" aria-hidden /> Search
          </Button>
        </form>
        {searchError && (
          <p role="alert" className="mt-2 text-[13px] text-[var(--hue-danger-ink)]">
            {searchError}
          </p>
        )}
        {results && results.length === 0 && <p className="mt-3 text-[13px] text-tx-3">No member matches that. Archived members are included.</p>}
        {results && results.length > 0 && (
          <ul className="mt-3 divide-y divide-[var(--bd-default)] rounded-[var(--r-md)] border border-bd-default" aria-label="Matching members">
            {results.map((r) => (
              <li key={r.id}>
                <Button
                  variant="ghost"
                  onClick={() => void pick(r)}
                  aria-pressed={selected?.id === r.id}
                  className="h-auto w-full justify-between gap-3 rounded-none px-3 py-2 text-left font-normal"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-tx-1">{r.name}</span>
                    <span className="block truncate text-xs text-tx-3">{r.erased ? "Personal data erased" : r.email}</span>
                  </span>
                  <span className="shrink-0 text-xs text-tx-3">{r.archivedAt ? "Archived" : r.status === "cancelled" ? "Cancelled" : ""}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <section aria-label={`Data request for ${selected.name}`} className="space-y-4 rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-5">
          <div>
            <p className="text-sm font-semibold text-tx-1">{selected.name}</p>
            <p className="text-xs text-tx-3">
              {selected.erased ? "Personal data erased" : selected.email}
              {selected.archivedAt ? ` · archived ${formatDate(selected.archivedAt)}` : ""} · joined {formatDate(selected.joinedAt)}
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-tx-1">Export their data</h3>
            <p className="mt-1 text-[13px] text-tx-3">
              One JSON file with everything MatFlow holds about them: profile, attendance, payments, waivers, ranks, bookings and the
              emails sent to them. Send it to them as your reply to a subject access request.
            </p>
            <Button className="mt-3" variant="secondary" loading={exporting} onClick={doExport} disabled={selected.erased}>
              Download export
            </Button>
          </div>

          <div className="border-t border-bd-default pt-4">
            <h3 className="text-sm font-semibold text-tx-1">Erase their personal data</h3>
            <p className="mt-1 text-[13px] text-tx-3">
              Removes their name, email, phone, date of birth, emergency contact, medical notes, photos, password and staff notes,
              and marks them cancelled, so they leave the active count. Their attendance and payment totals stay as anonymised
              records, and a record of the erasure is kept as evidence that you fulfilled the request. Export first if they asked for
              a copy.
            </p>
            {selected.erased && <p className="mt-2 text-[13px] text-tx-2">This person&rsquo;s personal data has already been erased.</p>}
            {!selected.erased && needsChildChoice && (
              <div className="mt-3 rounded-[var(--r-md)] border border-bd-default p-3">
                <div className="flex items-start gap-2">
                  <Checkbox checked={eraseChildren} onCheckedChange={setEraseChildren} aria-labelledby="data-request-erase-children" />
                  <span id="data-request-erase-children" className="text-[13px] text-tx-2">
                    Also delete the {children} child {children === 1 ? "account" : "accounts"} they are guardian for, entirely: their visits, belts and class packs go too
                  </span>
                </div>
                <p className="mt-2 text-xs text-tx-3">
                  To keep the {children === 1 ? "child" : "children"} instead, link them to another parent from the child&rsquo;s profile first.
                </p>
              </div>
            )}
            {!selected.erased && (
              <Button
                className="mt-3"
                variant="destructive"
                loading={erasing}
                onClick={doErase}
                disabled={children === null || (needsChildChoice && !eraseChildren)}
              >
                Erase personal data
              </Button>
            )}
          </div>

          {actionError && (
            <p role="alert" className="text-[13px] text-[var(--hue-danger-ink)]">
              {actionError}
            </p>
          )}
        </section>
      )}
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
