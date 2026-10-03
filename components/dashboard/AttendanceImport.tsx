"use client";

/**
 * Settings → Import → Attendance history (3 Oct 2026).
 *
 * The whole workflow for a TeamUp attendance export: choose the file → the
 * header is checked in the browser → the file is uploaded in verified parts
 * (each request well under the host's body limit) → preview → the owner
 * decides which club venue and class each source label is, and who the
 * people MatFlow cannot identify are → confirm → the import runs in steps with
 * progress → result, ledger CSV and rollback. Reopening the panel finds an
 * import still waiting or running and offers to carry on.
 *
 * Server: app/api/admin/import/attendance (engine lib/attendance-import.ts).
 * Nothing here can charge, notify or use a class credit, and the copy says so
 * only because the server guarantees it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, CheckCircle2, AlertCircle, Download, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { plural } from "@/components/dashboard/ImportHistory";
import { sniffCsvKind, WRONG_PATH_MESSAGE } from "@/lib/importers/sniff";
import { uploadFileInChunks, type UploadProgress } from "@/lib/import-upload-client";
import { formatDate, formatDateTime } from "@/lib/date";

type Decision = { action: string; targetId?: string | null } | null;
type Candidate = { memberId: string; reason: "same_name" | "same_email"; name: string };
type PendingPerson = {
  personKey: string; name: string; email: string; bookings: number; attended: number;
  sharedEmail: boolean; missingEmail: boolean; decidedPending: boolean; candidates: Candidate[];
};
type Summary = {
  controls: {
    rows: number; byStatus: Record<string, number>; identities: number; distinctEmails: number; sharedEmails: number;
    missingEmailRows: number; missingEmailIdentities: number; offerings: number; venues: number; distinctStarts: number;
    provisionalSessions: number; byBookingMethod: Record<string, number>; customerMembershipRefs: number; membershipRefs: number;
    firstStart: string | null; lastStart: string | null;
  };
  columns: { notImported: string[]; unmapped: string[]; blank: string[] };
  rows: number; bookings: number; duplicates: number; rejected: number; rejectedByReason: Record<string, number>;
  byIntent: Record<string, number>; reconciles: boolean;
  forecast: Record<string, number>;
  people: { total: number; matched: number; pending: number; pendingBookings: number; pendingAttended: number; sharedEmail: number; missingEmail: number; byMethod: Record<string, number>; pendingList: PendingPerson[]; pendingListTruncated: boolean };
  offerings: { label: string; bookings: number; attended: number; decision: Decision; decisionClassName: string | null; suggestedClassId: string | null }[];
  venues: { label: string; bookings: number; decision: Decision; suggestedLocationId: string | null }[];
  sessions: { provisional: number; byState: Record<string, number>; withAttendance: number; sameStartVisits: number; newHistoricalClasses: number };
  undecided: { offerings: string[]; venues: string[] };
  committable: boolean;
  targets: { classes: { id: string; name: string; isActive: boolean; historical: boolean }[]; locations: { id: string; name: string }[] };
};
type JobView = {
  id: string; status: string; phase: string; fileName: string; total: number; processed: number; attendanceCreated: number;
  sourceExportedAt: string | null; sourceExportedAtProvenance: string | null; stepInFlight: boolean;
  progress: Record<string, unknown> | null; manifest: Record<string, unknown> | null; error: unknown;
};

const STATUS_WORDS: Record<string, string> = { Attended: "attended", Registered: "registered (booked, not marked attended)", "Late Cancelled": "late cancelled", "No show": "no-show" };
const INTENT_WORDS: Record<string, string> = {
  attendance: "become attendance",
  same_start_visit: "are a second booking at the same start as a visit already counted",
  booking_only: "are kept as bookings, not attendance",
  future: "are for sessions not yet held",
  pending_person: "wait for you to say who the person is",
  pending_offering: "wait for a class decision",
  pending_venue: "wait for a venue decision",
  venue_conflict: "wait: the venue does not match the class",
  source_conflict: "wait: the export contradicts itself",
};
const DISPOSITION_WORDS: Record<string, string> = {
  attendance_created: "attendance recorded",
  attendance_existing: "already recorded, linked",
  booking_only: "kept as bookings only",
  future: "sessions not yet held",
  pending_person: "waiting: who is this?",
  pending_offering: "waiting: which class?",
  pending_venue: "waiting: which venue?",
  venue_conflict: "waiting: venue does not match class",
  pending_conflict: "waiting: export contradicts itself",
  staff_removed: "removed by staff, not recreated",
};
const n = (x: number | undefined) => (x ?? 0).toLocaleString("en-GB");
const words = (m: Record<string, number>, w: Record<string, string>) =>
  Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${n(v)} ${w[k] ?? k.replace(/_/g, " ")}`).join(" · ");

/**
 * Undecided venues and offerings start with MatFlow's suggestion selected — as
 * an UNSAVED choice the owner confirms with Save, never as a decision.
 */
function suggestedDrafts(s: Summary | null | undefined): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const v of s.venues) {
    if (v.decision) continue;
    if (v.suggestedLocationId) out[`venue:${v.label}`] = `location|${v.suggestedLocationId}`;
    else if (s.targets.locations.length === 0) out[`venue:${v.label}`] = "club";
  }
  for (const o of s.offerings) if (!o.decision && o.suggestedClassId) out[`offering:${o.label}`] = `class|${o.suggestedClassId}`;
  return out;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return (data && typeof data.error === "string" && data.error) || fallback;
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-bd-default bg-sf-0 px-3 py-2">
      <p className="text-[11px] text-tx-3">{label}</p>
      <p className="text-sm font-semibold text-tx-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-tx-4">{hint}</p>}
    </div>
  );
}

/**
 * Who an unidentified source person is: a suggested member, any member found
 * by search, or "keep pending". A choice is a draft until Save.
 */
function PersonPicker({ id, label, candidates, value, onChange }: {
  id: string; label: string; candidates: Candidate[]; value: string; onChange: (value: string) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  async function search(term: string) {
    setQ(term);
    setSearchError(null);
    if (term.trim().length < 2) { setResults(null); return; }
    try {
      const res = await fetch(`/api/members?search=${encodeURIComponent(term.trim())}&limit=8`);
      if (!res.ok) { setResults(null); setSearchError("Member search failed. Try again."); return; }
      const data = await res.json();
      setResults(((data.members ?? []) as { id: string; name: string }[]).map((m) => ({ id: m.id, name: m.name })));
    } catch {
      setSearchError("Couldn't reach MatFlow to search members.");
    }
  }
  return (
    <div className="space-y-1">
      <Select id={id} aria-label={label} value={value} onChange={(e) => { if (e.target.value === "__search") { setSearching(true); return; } onChange(e.target.value); }} data-testid="attendance-person-select">
        <option value="">Not decided</option>
        <option value="pending">Keep pending</option>
        {candidates.map((cand) => <option key={cand.memberId} value={`member|${cand.memberId}`}>{cand.name} ({cand.reason === "same_name" ? "same name" : "same email"})</option>)}
        {chosen && !candidates.some((c) => c.memberId === chosen.id) && <option value={`member|${chosen.id}`}>{chosen.name} (chosen)</option>}
        <option value="__search">Someone else — search members…</option>
      </Select>
      {searching && (
        <div className="space-y-1">
          <input aria-label={`Search members for ${label}`} value={q} onChange={(e) => void search(e.target.value)} placeholder="Type a name or email" className="w-full px-3 py-2 rounded-[var(--r-md)] text-[13px] bg-transparent border border-bd-default text-tx-1 outline-none" />
          {searchError && <p role="alert" className="text-[11px] text-[var(--hue-danger-ink)]">{searchError}</p>}
          {results && results.length === 0 && <p className="text-[11px] text-tx-4">No member matches. Add them under Members first.</p>}
          {results && results.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {results.map((m) => (
                <Button key={m.id} type="button" variant="secondary" size="compact" onClick={() => { setChosen(m); setSearching(false); onChange(`member|${m.id}`); }}>{m.name}</Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AttendanceImport({ primaryColor, onChanged }: { primaryColor: string; onChanged: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [exportedAt, setExportedAt] = useState("");
  const [estimate, setEstimate] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState<null | "upload" | "preview" | "decide" | "commit">(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [planHash, setPlanHash] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [exportParts, setExportParts] = useState<number | null>(null);
  const stopRef = useRef(false);
  const { ask, dialogProps } = useConfirmDialog();

  const adopt = useCallback((data: { job?: JobView | null; jobId?: string; summary?: Summary | null; planHash?: string | null }) => {
    if (data.job !== undefined) setJob(data.job);
    if (data.summary !== undefined) setSummary(data.summary ?? null);
    if (data.planHash !== undefined) setPlanHash(data.planHash ?? null);
    setDrafts(data.summary !== undefined ? suggestedDrafts(data.summary) : {});
  }, []);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/import/attendance?latest=1");
      if (!res.ok) { setLoadError(await readError(res, "Could not check for an import in progress.")); return; }
      adopt(await res.json());
    } catch {
      setLoadError("Couldn't reach MatFlow to check for an import in progress.");
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  useEffect(() => { void loadLatest(); return () => { stopRef.current = true; }; }, [loadLatest]);

  // The ledger CSV comes in parts (a response is capped at 4.5 MB on the host).
  useEffect(() => {
    if (job?.phase !== "completed") return;
    let live = true;
    fetch(`/api/admin/import/attendance/export?jobId=${encodeURIComponent(job.id)}&info=1`)
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) { setExportParts(-1); return; }
        const d = await r.json();
        setExportParts(typeof d.parts === "number" ? d.parts : -1);
      })
      .catch(() => { if (live) setExportParts(-1); });
    return () => { live = false; };
  }, [job?.id, job?.phase]);

  async function chooseFile(next: File | null) {
    setFile(next);
    setMismatch(null);
    setError(null);
    if (!next) return;
    try {
      const kind = sniffCsvKind(await next.slice(0, 4096).text());
      if (kind === "teamup_memberships") setMismatch(WRONG_PATH_MESSAGE.membershipsAsAttendance);
      else if (kind !== "teamup_attendance") setMismatch("This does not look like an attendance export (no class or offering, start, status and customer columns). Check it is TeamUp's attendance report.");
    } catch { /* the server checks the header again */ }
  }

  async function uploadAndPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!file || mismatch) return;
    setError(null);
    setBusy("upload");
    try {
      const up = await uploadFileInChunks(file, { purpose: "attendance", onProgress: setUpload });
      setBusy("preview");
      const res = await fetch("/api/admin/import/attendance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", uploadId: up.uploadId, sourceExportedAtLocal: exportedAt, ...(estimate ? { sourceExportedAtProvenance: "provisional" } : {}) }),
      });
      if (!res.ok) { setError(await readError(res, "Preview failed — nothing was imported.")); return; }
      const data = await res.json();
      const jobRes = await fetch(`/api/admin/import/attendance?jobId=${encodeURIComponent(data.jobId)}`);
      if (!jobRes.ok) { setError(await readError(jobRes, "The preview was made but could not be reloaded — refresh the page.")); return; }
      adopt(await jobRes.json());
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't reach MatFlow — check your connection and try again.");
    } finally {
      setBusy(null);
      setUpload(null);
    }
  }

  async function saveDecisions() {
    if (!job || !summary) return;
    const decisions: { kind: string; sourceKey: string; action: string; targetId?: string }[] = [];
    for (const [key, value] of Object.entries(drafts)) {
      if (!value) continue;
      const [kind, ...rest] = key.split(":");
      const sourceKey = rest.join(":");
      const [action, targetId] = value.split("|");
      decisions.push({ kind, sourceKey, action, ...(targetId ? { targetId } : {}) });
    }
    if (!decisions.length) return;
    setBusy("decide");
    setError(null);
    try {
      const res = await fetch("/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "decide", jobId: job.id, decisions }) });
      if (!res.ok) { setError(await readError(res, "Your decisions were not saved.")); return; }
      const data = await res.json();
      adopt({ summary: data.summary, planHash: data.planHash });
    } catch {
      setError("Couldn't reach MatFlow — your decisions may not have been saved. Reload to check.");
    } finally {
      setBusy(null);
    }
  }

  const runSteps = useCallback(async (jobId: string) => {
    setRunning(true);
    stopRef.current = false;
    try {
      for (;;) {
        if (stopRef.current) return;
        const res = await fetch("/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "step", jobId }) });
        const data = await res.json().catch(() => null);
        if (data?.job) setJob(data.job);
        if (res.status === 202 && data?.busy) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        if (!res.ok) { setError((data && data.error) || "The import stopped. It can be resumed from where it stopped."); return; }
        if (data?.done) { onChanged(); return; }
      }
    } catch {
      setError("Lost contact with MatFlow. The import keeps every part already saved; resume it when you are back online.");
    } finally {
      setRunning(false);
    }
  }, [onChanged]);

  async function commit() {
    if (!job || !summary || !planHash) return;
    const ok = await ask({
      title: "Import this attendance history?",
      body: `${n(summary.byIntent.attendance)} visits become attendance and ${n(summary.bookings)} bookings are kept with their TeamUp status. These are past visits only: nobody is charged or notified, no class credits are used and no memberships change. You can roll the import back from the import history.`,
      confirmLabel: "Import",
    });
    if (!ok) return;
    setBusy("commit");
    setError(null);
    try {
      const res = await fetch("/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "commit", jobId: job.id, planHash }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError((data && data.error) || "The import did not start.");
        if (data?.stale) {
          const again = await fetch("/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "repreview", jobId: job.id }) });
          if (again.ok) { const d = await again.json(); adopt({ summary: d.summary, planHash: d.planHash }); }
        }
        return;
      }
      if (data?.job) setJob(data.job);
      setSummary(null);
      onChanged();
      void runSteps(job.id);
    } catch {
      setError("Couldn't reach MatFlow, so we don't know whether the import started. Reload to check before trying again.");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    // A preview set aside is discarded on the server too, so it is never offered (or committable) again.
    if (job?.status === "preview") {
      const res = await fetch("/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "discard", jobId: job.id }) }).catch(() => null);
      if (!res?.ok) { setError("The preview could not be set aside. Try again."); return; }
      onChanged();
    }
    stopRef.current = true;
    setJob(null); setSummary(null); setPlanHash(null); setFile(null); setMismatch(null); setError(null); setDrafts({});
  }

  if (loading) return <p className="text-xs text-tx-3" role="status">Checking for an attendance import in progress…</p>;
  if (loadError) {
    return (
      <div role="alert" className="rounded-xl border border-bd-default bg-sf-0 p-4 text-xs text-tx-2 space-y-2">
        <p className="flex items-center gap-2 font-medium text-[var(--hue-danger-ink)]"><AlertCircle className="w-4 h-4" />{loadError}</p>
        <Button variant="secondary" size="compact" onClick={() => void loadLatest()}><RotateCw className="w-4 h-4" />Try again</Button>
      </div>
    );
  }

  const errorLine = error && (
    <p role="alert" className="text-xs font-medium text-[var(--hue-danger-ink)] flex items-start gap-2" data-testid="attendance-import-error">
      <AlertCircle className="w-4 h-4 shrink-0" />{error}
    </p>
  );

  // ── Running, stopped part-way, or finished ─────────────────────────────────
  if (job && job.status !== "preview") {
    const pct = job.total ? Math.floor((job.processed / job.total) * 100) : 0;
    const done = job.phase === "completed";
    const m = (job.manifest ?? {}) as { outcomes?: Record<string, number>; dispositions?: Record<string, number>; attendance?: { createdByThisImport?: number; linkedToExisting?: number }; sessions?: { created?: number }; classes?: { created?: number }; reconciles?: boolean; input?: { rows?: number; duplicates?: number; rejected?: number } };
    return (
      <div className="space-y-3" data-testid="attendance-import-job">
        <div className="rounded-xl border border-bd-default bg-sf-0 p-4 space-y-2">
          <p className="text-sm font-semibold text-tx-1 flex items-center gap-2">
            {done ? <CheckCircle2 className="w-4 h-4 text-[var(--hue-success-ink)]" /> : null}
            {done ? "Attendance history imported" : job.phase === "partial" || job.phase === "failed" ? "Import stopped part-way" : "Importing attendance history…"}
          </p>
          <p className="text-xs text-tx-3">{job.fileName}{job.sourceExportedAt ? ` · exported ${formatDateTime(job.sourceExportedAt)}${job.sourceExportedAtProvenance === "provisional" ? " (estimate)" : ""}` : ""}</p>
          {!done && (
            <>
              <div className="h-2 rounded-full bg-sf-2 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress">
                <div className="h-full" style={{ width: `${pct}%`, background: primaryColor }} />
              </div>
              <p className="text-xs text-tx-2 tabular-nums" data-testid="attendance-import-progress">{n(job.processed)} of {n(job.total)} bookings ({pct}%)</p>
              {!running && (
                <Button size="compact" onClick={() => void runSteps(job.id)} style={{ background: primaryColor }} data-testid="attendance-import-resume">
                  <RotateCw className="w-4 h-4" />{job.processed > 0 ? "Resume from where it stopped" : "Start"}
                </Button>
              )}
              <p className="text-[11px] text-tx-4">Each part is saved as it finishes. If this page is closed the import waits here and carries on when you resume — nothing is counted twice.</p>
            </>
          )}
          {done && (
            <div className="space-y-2 text-xs text-tx-2" data-testid="attendance-import-complete">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Fact label="Visits recorded" value={n(m.attendance?.createdByThisImport)} />
                <Fact label="Already recorded" value={n(m.attendance?.linkedToExisting)} hint="linked, not counted twice" />
                <Fact label="Past sessions added" value={n(m.sessions?.created)} />
                <Fact label="Historical classes" value={n(m.classes?.created)} hint="not on the timetable" />
              </div>
              <p>Bookings: {words(m.dispositions ?? {}, DISPOSITION_WORDS) || "none"}.</p>
              <p>This run: {words(m.outcomes ?? {}, { created: "new", updated: "updated", unchanged: "already up to date", stale: "older than what MatFlow has (left alone)", protected: "changed by staff (left alone)" })}.</p>
              <p data-testid="attendance-commit-reconciliation">
                {m.reconciles
                  ? `Every one of the ${n(m.input?.rows)} rows is accounted for.`
                  : "Warning: the counts do not add up to the rows in the file — check the ledger before relying on this import."}
              </p>
              <div className="flex flex-wrap gap-2">
                {exportParts === null && <span className="text-xs text-tx-3">Preparing the booking ledger download…</span>}
                {exportParts === -1 && <span role="alert" className="text-xs text-[var(--hue-danger-ink)]">The booking ledger download could not be prepared. Reload the page to try again.</span>}
                {exportParts !== null && exportParts > 0 && Array.from({ length: exportParts }, (_, i) => (
                  <a key={i} href={`/api/admin/import/attendance/export?jobId=${encodeURIComponent(job.id)}&part=${i + 1}`} className="inline-flex items-center gap-2 h-8 px-3 rounded-[var(--r-md)] border border-bd-default text-[13px] text-tx-1 hover:bg-sf-2" data-testid="attendance-ledger-download">
                    <Download className="w-4 h-4" />Booking ledger (CSV){exportParts > 1 ? ` · part ${i + 1} of ${exportParts}` : ""}
                  </a>
                ))}
                <Button variant="secondary" size="compact" onClick={() => void reset()}>Import another file</Button>
              </div>
              <p className="text-[11px] text-tx-4">Nobody was charged or notified, no class credits were used and no memberships changed. Roll it back from the import history below if something looks wrong.</p>
            </div>
          )}
          {errorLine}
        </div>
      </div>
    );
  }

  // ── Preview and decisions ──────────────────────────────────────────────────
  if (job && summary) {
    const c = summary.controls;
    const draftOf = (key: string, fallback: string) => drafts[key] ?? fallback;
    const setDraft = (key: string, v: string) => setDrafts((d) => ({ ...d, [key]: v }));
    const decisionValue = (d: Decision) => (d ? (d.targetId ? `${d.action}|${d.targetId}` : d.action) : "");
    const unsaved = Object.entries(drafts).filter(([, v]) => v).length;
    return (
      <div className="space-y-4" data-testid="attendance-preview">
        <div className="rounded-xl border border-bd-default bg-sf-0 p-4 space-y-3">
          <p className="text-sm font-semibold text-tx-1">{job.fileName}</p>
          <p className="text-xs text-tx-3">
            Exported {job.sourceExportedAt ? formatDateTime(job.sourceExportedAt) : "—"}{job.sourceExportedAtProvenance === "provisional" ? " (estimate)" : ""}
            {c.firstStart && c.lastStart ? ` · sessions ${formatDate(c.firstStart)} to ${formatDate(c.lastStart)}` : ""}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="attendance-controls">
            <Fact label="Rows" value={n(c.rows)} />
            <Fact label="People" value={n(c.identities)} hint={`${n(c.sharedEmails)} shared emails · ${n(c.missingEmailIdentities)} without email`} />
            <Fact label="Sessions in the file" value={n(c.provisionalSessions)} hint={`${n(c.distinctStarts)} start times · ${n(c.offerings)} offerings`} />
            <Fact label="Venues" value={n(c.venues)} />
          </div>
          <p className="text-xs text-tx-2" data-testid="attendance-status-counts">TeamUp status: {words(c.byStatus, STATUS_WORDS)}. Only attended visits count as attendance; every other status is kept as a booking.</p>
          <p className="text-xs text-tx-2">Booking method: {words(c.byBookingMethod, {})} — kept as a record of how each was booked, not as a payment.</p>
          {summary.columns.blank.length > 0 && <p className="text-xs text-tx-2">Empty in this export, so not known: {summary.columns.blank.join(", ")}. Imported visits are dated by the session start; the actual check-in time is recorded as not known.</p>}
          {summary.columns.notImported.length > 0 && <p className="text-[11px] text-tx-4">Not imported: {summary.columns.notImported.join(", ")}. Profiles come from the members import; an attendance file never changes them.</p>}
          {summary.columns.unmapped.length > 0 && <p className="text-xs font-medium text-tx-1">Columns MatFlow does not read: {summary.columns.unmapped.join(", ")}.</p>}
          {summary.rejected > 0 && <p role="alert" className="text-xs font-medium text-[var(--hue-danger-ink)]">{plural(summary.rejected, "row could not be read", "rows could not be read")}: {words(summary.rejectedByReason, {})}. Fix the export and upload it again — nothing is imported until every row can be read.</p>}
          <p className="text-xs text-tx-2" data-testid="attendance-intents">If imported now: {words(summary.byIntent, INTENT_WORDS)}.{summary.duplicates > 0 ? ` ${plural(summary.duplicates, "row repeats", "rows repeat")} a booking already in the file.` : ""}</p>
          {(summary.forecast.unchanged > 0 || summary.forecast.status_update > 0 || summary.forecast.stale > 0) && (
            <p className="text-xs text-tx-2" data-testid="attendance-forecast">Against what MatFlow already has: {words(summary.forecast, { new: "new", unchanged: "already imported", status_update: "status changes from this newer export", resolution_update: "newly resolved", stale: "older than what MatFlow has (left alone)" })}.</p>
          )}
        </div>

        <section className="rounded-xl border border-bd-default bg-sf-0 p-4 space-y-3" aria-labelledby="att-venues">
          <h3 id="att-venues" className="text-sm font-semibold text-tx-1">Venue</h3>
          {summary.venues.map((v) => {
            const key = `venue:${v.label}`;
            const fallback = decisionValue(v.decision);
            return (
              <div key={key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 items-center">
                <label htmlFor={key} className="text-xs text-tx-1">{v.label} <span className="text-tx-3">· {n(v.bookings)} bookings{v.decision ? "" : " · not decided"}</span></label>
                <Select id={key} aria-label={`Venue for ${v.label}`} value={draftOf(key, fallback)} onChange={(e) => setDraft(key, e.target.value)} data-testid="attendance-venue-select">
                  <option value="">Choose…</option>
                  <option value="club">This club (no specific location)</option>
                  {summary.targets.locations.map((l) => <option key={l.id} value={`location|${l.id}`}>{l.name}</option>)}
                  <option value="pending">Leave pending (not imported as attendance)</option>
                </Select>
              </div>
            );
          })}
        </section>

        <section className="rounded-xl border border-bd-default bg-sf-0 p-4 space-y-2" aria-labelledby="att-offerings">
          <h3 id="att-offerings" className="text-sm font-semibold text-tx-1">Classes</h3>
          <p className="text-[11px] text-tx-4">Map each TeamUp offering to a class on your timetable, or keep its history under a historical class: one that holds past sessions only, never appears on the timetable, at the door or for booking, and has no coach, length or capacity set.</p>
          {summary.offerings.map((o) => {
            const key = `offering:${o.label}`;
            const fallback = decisionValue(o.decision);
            return (
              <div key={key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 items-center">
                <label htmlFor={key} className="text-xs text-tx-1">{o.label} <span className="text-tx-3">· {n(o.attended)} attended of {n(o.bookings)}{o.decision ? "" : " · not decided"}</span></label>
                <Select id={key} aria-label={`Class for ${o.label}`} value={draftOf(key, fallback)} onChange={(e) => setDraft(key, e.target.value)} data-testid="attendance-offering-select">
                  <option value="">Choose…</option>
                  <option value="new_class">Historical class “{o.label}” (not on the timetable)</option>
                  {summary.targets.classes.filter((cl) => cl.isActive).map((cl) => <option key={cl.id} value={`class|${cl.id}`}>{cl.name} (timetable)</option>)}
                  {summary.targets.classes.filter((cl) => cl.historical).map((cl) => <option key={cl.id} value={`class|${cl.id}`}>{cl.name} (historical)</option>)}
                  <option value="pending">Leave pending (not imported as attendance)</option>
                </Select>
              </div>
            );
          })}
        </section>

        <section className="rounded-xl border border-bd-default bg-sf-0 p-4 space-y-2" aria-labelledby="att-people" data-testid="attendance-people">
          <h3 id="att-people" className="text-sm font-semibold text-tx-1">People</h3>
          <p className="text-xs text-tx-2">
            {n(summary.people.matched)} of {n(summary.people.total)} matched to members ({words(summary.people.byMethod, { external_ref: "by their TeamUp identity from the members import", name_and_email: "by exact name and email", decision: "by your decision", kept_pending: "kept pending by you", unresolved: "not identified" })}).
          </p>
          {summary.people.pending > 0 && (
            <p className="text-xs text-tx-2">
              {plural(summary.people.pending, "person is", "people are")} not identified ({n(summary.people.pendingAttended)} attended visits, {n(summary.people.pendingBookings)} bookings). Their bookings are kept privately as pending and become attendance when you say who they are. A name, a shared email or a family link alone never decides it.
            </p>
          )}
          {summary.people.pendingList.map((p) => {
            const key = `person:${p.personKey}`;
            return (
              <div key={key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 items-center border-t border-bd-default pt-2">
                <label htmlFor={key} className="text-xs text-tx-1">
                  {p.name || "(no name)"} <span className="text-tx-3">· {p.email || "no email"} · {n(p.attended)} attended</span>
                  {p.sharedEmail && <span className="ml-1 text-tx-3">· email shared with others</span>}
                  {p.decidedPending && <span className="ml-1 text-tx-3">· kept pending</span>}
                </label>
                <PersonPicker id={key} label={`Who is ${p.name || "this person"}`} candidates={p.candidates} value={draftOf(key, p.decidedPending ? "pending" : "")} onChange={(v) => setDraft(key, v)} />
              </div>
            );
          })}
          {summary.people.pendingListTruncated && <p className="text-[11px] text-tx-4">Showing the first {summary.people.pendingList.length}; decide these and preview again for the rest.</p>}
          {summary.people.pendingList.some((p) => p.candidates.length === 0) && (
            <p className="text-[11px] text-tx-4">Someone with no suggestion is not a member yet: add them under Members, then preview again — they match by exact name and email, or choose them here.</p>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void saveDecisions()} disabled={busy !== null || unsaved === 0} loading={busy === "decide"} data-testid="attendance-save-decisions">
            Save {unsaved > 0 ? plural(unsaved, "decision", "decisions") : "decisions"} and preview again
          </Button>
          <Button onClick={() => void commit()} disabled={busy !== null || !summary.committable || unsaved > 0} loading={busy === "commit"} style={{ background: primaryColor }} data-testid="attendance-import-confirm">
            Import attendance history
          </Button>
          <Button variant="ghost" onClick={() => void reset()} disabled={busy !== null}>Choose another file</Button>
        </div>
        {!summary.committable && (
          <p className="text-xs text-tx-2" data-testid="attendance-not-committable">
            {summary.undecided.venues.length + summary.undecided.offerings.length > 0
              ? `Decide ${[summary.undecided.venues.length ? plural(summary.undecided.venues.length, "venue", "venues") : "", summary.undecided.offerings.length ? plural(summary.undecided.offerings.length, "class", "classes") : ""].filter(Boolean).join(" and ")} first (choose, then save).`
              : "Fix the rows that could not be read first."}
          </p>
        )}
        {unsaved > 0 && summary.committable && <p className="text-xs text-tx-2">Save your decisions to see their effect before importing.</p>}
        {errorLine}
        <ConfirmDialog {...dialogProps} />
      </div>
    );
  }

  // ── Choose a file ──────────────────────────────────────────────────────────
  const pct = upload?.totalBytes ? Math.floor((upload.sentBytes / upload.totalBytes) * 100) : 0;
  return (
    <form onSubmit={uploadAndPreview} className="space-y-3" data-testid="attendance-import-form">
      <p className="text-[11px] text-tx-4">
        TeamUp attendance report, one row per booking. Import the members first: people are matched by the TeamUp identity the members import kept, never by name alone.
      </p>
      <div>
        <label htmlFor="attendance-file" className="block text-xs mb-1 text-tx-3">CSV file (up to 25 MB)</label>
        <input id="attendance-file" type="file" required accept=".csv,text/csv,application/csv,application/vnd.ms-excel" onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} className="w-full text-sm text-tx-2" />
        {mismatch && <p role="alert" className="text-xs mt-1 font-medium text-[var(--hue-danger-ink)]" data-testid="import-file-mismatch">{mismatch}</p>}
      </div>
      <div>
        <label htmlFor="attendance-exported-at" className="block text-xs mb-1 text-tx-3">When was this file exported? Club time</label>
        <input id="attendance-exported-at" type="datetime-local" required value={exportedAt} onChange={(e) => setExportedAt(e.target.value)} className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border border-bd-default text-tx-1 outline-none" />
        <p className="text-[11px] mt-1 text-tx-4">A later export only changes a booking when it is newer than this one. Enter the time at the club, wherever you are now.</p>
        <div className="mt-2 flex items-start gap-2">
          <Checkbox id="attendance-exported-at-estimate" checked={estimate} onCheckedChange={setEstimate} />
          <label htmlFor="attendance-exported-at-estimate" className="text-xs text-tx-2 cursor-pointer">This is an estimate</label>
        </div>
      </div>
      {busy === "upload" && upload && (
        <div className="space-y-1" data-testid="attendance-upload-progress">
          <div className="h-2 rounded-full bg-sf-2 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Upload progress">
            <div className="h-full" style={{ width: `${upload.phase === "hashing" ? 0 : pct}%`, background: primaryColor }} />
          </div>
          <p className="text-xs text-tx-2">{upload.phase === "hashing" ? "Checking the file…" : upload.phase === "verifying" ? "Verifying the upload…" : `Uploading ${pct}%`}</p>
        </div>
      )}
      <Button type="submit" disabled={!file || !exportedAt || busy !== null || mismatch !== null} loading={busy !== null} style={{ background: primaryColor }} data-testid="attendance-upload-preview">
        {busy === null && <Upload className="w-4 h-4" />}
        {busy === "upload" ? "Uploading…" : busy === "preview" ? "Reading the file…" : "Upload and preview"}
      </Button>
      {errorLine}
    </form>
  );
}
