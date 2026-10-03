"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Upload, FileText, CheckCircle2, AlertCircle, Database } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import ImportHistory, { plural } from "@/components/dashboard/ImportHistory";
import AttendanceImport from "@/components/dashboard/AttendanceImport";
import { describeApiError } from "@/lib/api-field-errors";
import { formatDate, formatDateTime } from "@/lib/date";
import { EXCEPTION_WORDS, countByKind, type ExceptionRow } from "@/lib/importers/teamup-exceptions";
import { sniffCsvKind, WRONG_PATH_MESSAGE, type CsvKind } from "@/lib/importers/sniff";

const SOURCES = [
  { value: "generic", label: "Generic CSV", hint: "Standard headers: name, email, phone, dob, membership, status, joined" },
  { value: "mindbody", label: "MindBody", hint: "Client export from MindBody" },
  { value: "glofox", label: "Glofox", hint: "Member export from Glofox" },
  { value: "wodify", label: "Wodify", hint: "Athlete export from Wodify" },
  { value: "teamup", label: "TeamUp", hint: "Memberships report export (one row per membership; people, families and holds are worked out for you)" },
] as const;

type Source = typeof SOURCES[number]["value"];
type Kind = "members" | "attendance";
/** TeamUp only: add people (the first import) or refresh the standing of people already imported. */
type Mode = "create" | "refresh";

type Job = {
  id: string;
  source: string;
  mode?: Mode;
  fileName: string;
  status: string;
  totalRows: number;
  processedRows: number;
  importedRows: number;
  skippedRows: number;
  errorRows: number;
  errorLog: { row: number; reason: string }[] | null;
  dryRunSummary: PreviewSummary | null;
  sourceExportedAt?: string | null;
  /** "owner_stated" | "provisional" | null (no time given). */
  sourceExportedAtProvenance?: string | null;
  mappingVersion?: string | null;
  rolledBackAt?: string | null;
  manifest?: {
    reconciles?: boolean;
    mode?: Mode;
    refresh?: { changed: number; unchanged: number; exceptions: RefreshExceptions };
    created?: { total: number; unmatchedPlan: number };
    rollback?: { removed: number; kept: { memberId: string; name: string; reasons: string[] }[] };
    teamup2?: TeamUp2Facts;
  } | null;
};

/** teamup-2 (2 Oct 2026): what the import worked out and what the owner must decide. */
type TeamUp2Facts = {
  asOf: string;
  asOfIsProvisional?: boolean;
  /** "owner_stated" | "provisional" | null (no export time given). */
  asOfProvenance?: string | null;
  ledger: { rows: number; persisted?: number | null; byDisposition: Record<string, number> };
  decisions: { name: string; options: string[]; rows: number[] }[];
  scheduled: { name: string; planLabel: string; startDate: string; sourceRow: number }[];
  guardians: { suggestedFromSharedEmail: number; draftsFromEmergencyContact: number; kidsOnDrafts?: number };
  /**
   * unmatchedPlanLabels: labels a current / scheduled / held membership carries
   * with no tier (create them first). unmatchedHistoryPlanLabels: labels only
   * history rows carry — no tier needed.
   */
  exceptions: { missingEmailActive: number; sharedEmailAdults: number; cancelledWithoutDate: number; unmatchedPlanLabels: string[]; unmatchedHistoryPlanLabels?: string[]; refusedRows: number };
  exceptionRows?: ExceptionRow[];
};

type PreviewSummary = {
  totalRows: number;
  validRows: number;
  errorRows: number;
  existingMatches: number;
  willImport: number;
  willSkip: number;
  sampleDrafts: {
    name: string;
    email: string;
    membershipType?: string;
    nextDueAt?: string;
    paymentStatus?: string;
  }[];
  sampleErrors: { row: number; reason: string }[];
  /** TeamUp only: reconciliation figures against the source's own counts. */
  source?: {
    sourceRows: number;
    deletedRows: number;
    people: number;
    adults: number;
    kids: number;
    parentsSynthesised: number;
    kidsWithoutParent: number;
    noEmail: number;
    sharedEmailAdults: number;
    multipleLiveMemberships: number;
    currentActive: number;
    currentOnHold: number;
    historicalOnly: number;
    planCounts: Record<string, { active: number; hold: number }>;
  };
  teamup2?: TeamUp2Facts;
};

type RefreshExceptions = {
  notInMatFlow: { name: string; email: string | null; rows?: number[] }[];
  notInFile: { memberId: string; name: string }[];
  billedByMatFlow: { memberId: string; name: string }[];
  refused: { row: number; reason: string }[];
  holdKept?: { memberId: string; name: string; teamUpSays: string }[];
};

/** POST admin/import/[id]/preview for a status refresh (lib/importers/teamup-refresh). */
type RefreshPreview = {
  mode: "refresh";
  totalRows: number;
  matched: number;
  willChange: number;
  unchanged: number;
  reconciles: boolean;
  changes: { memberId: string; name: string; fields: { field: string; before: string | null; after: string | null }[] }[];
  exceptions: RefreshExceptions;
};

const REFRESH_FIELD_WORDS: Record<string, string> = {
  status: "Status",
  paymentStatus: "Payment",
  cancelledAt: "Cancelled",
  membershipType: "Plan",
  membershipTierId: "Tier",
};

function refreshValue(field: string, v: string | null): string {
  if (v === null || v === "") return "—";
  if (field === "cancelledAt") return formatDate(v);
  if (field === "membershipTierId") return "linked";
  return v;
}

export default function ImportPanel({ primaryColor }: { primaryColor: string }) {
  // All four routes behind this panel are `requireApiOwner`
  // (app/api/admin/import/upload:61, [id]/preview:16, [id]/commit:23, [id]:10).
  // Until this gate existed the panel rendered for anyone who could open the
  // settings screen, so a manager was shown a source picker, a file input and
  // an Upload button, every one of which answered 403 — a control that is
  // visible, enabled and cannot ever work.
  //
  // Hidden rather than disabled-with-a-notice: an import is not something a
  // manager is one permission away from doing, it is simply the owner's job,
  // and a greyed-out panel on the settings screen would only invite the
  // question. The owner sees it exactly as before.
  //
  // Read from the session rather than taken as a prop because the mounting
  // component (IntegrationsTab) belongs to another lane's surface; this keeps
  // the gate and the routes it mirrors in files that move together.
  const { data: session, status } = useSession();
  const isOwner = session?.user?.role === "owner";

  const [kind, setKind] = useState<Kind>("members");
  const [historyKey, setHistoryKey] = useState(0);
  const refreshHistory = () => setHistoryKey((k) => k + 1);

  const [source, setSource] = useState<Source>("generic");
  const [file, setFile] = useState<File | null>(null);
  // What the chosen file's header row says it is (lib/importers/sniff), and the
  // line shown when the panel changed the Source to match it.
  const [fileKind, setFileKind] = useState<CsvKind | null>(null);
  const [detectedNote, setDetectedNote] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [mode, setMode] = useState<Mode>("create");
  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);
  const [busy, setBusy] = useState<"upload" | "preview" | "commit" | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const { ask, dialogProps } = useConfirmDialog();

  async function sendInvites() {
    setInviteBusy(true);
    try {
      const res = await fetch("/api/members/bulk-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteResult(data.error ?? "Sending invites failed — you can retry per member from their profile.");
        return;
      }
      setInviteResult(
        `✓ Sent ${plural(data.invited ?? 0, "invite", "invites")}` +
        (data.failed?.length ? ` · ${data.failed.length} failed (retry from the member's profile)` : "") +
        ". Members have 7 days to set a password.",
      );
    } finally {
      setInviteBusy(false);
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [exportedAt, setExportedAt] = useState("");
  // The owner does not know the exact export time yet: the time is sent as
  // provisional and a status refresh with the real time corrects it.
  const [exportedAtEstimate, setExportedAtEstimate] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);

  async function rollback() {
    if (!job) return;
    const ok = job.mode === "refresh"
      ? await ask({
          title: "Roll back this status refresh?",
          body: "Puts back the status, payment standing and plan each member had before this refresh. Anyone changed since — by staff or by a later refresh — is left as they are, and you will see who and why.",
          confirmLabel: "Roll back",
          destructive: true,
        })
      : await ask({
      title: "Roll back this import?",
      // The count is this run's whole creation (a resumed run included); the
      // kept-with-reasons list comes back after (acceptance S11, 2 Oct 2026).
      body: `Removes the ${plural(job?.importedRows ?? 0, "member", "members")} this import created${job?.sourceExportedAt ? ` from the TeamUp export of ${formatDateTime(job.sourceExportedAt)}` : ""}, as long as nobody has touched them since — anyone who has signed in, checked in, paid, signed a waiver, confirmed a guardian or been edited is kept, and you will see who and why. This cannot be undone.`,
      confirmLabel: "Roll back",
      destructive: true,
    });
    if (!ok) return;
    setRollbackBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/import/${job.id}/rollback`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ? describeApiError(data) : "Rollback failed — nothing was removed."); return; }
      refreshHistory();
      const refreshed = await fetch(`/api/admin/import/${job.id}`);
      if (refreshed.ok) setJob(await refreshed.json());
      else setError("Rolled back, but the import record could not be reloaded — refresh the page.");
    } catch {
      setError("Couldn't reach MatFlow, so we don't know whether the rollback ran. Refresh and check the import before trying again.");
    } finally {
      setRollbackBusy(false);
    }
  }

  async function uploadAndPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy("upload");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("source", source);
      fd.append("mode", source === "teamup" ? mode : "create");
      // The wall-clock time as typed; the server reads it in the CLUB's
      // timezone (an owner abroad must not shift the as-of date).
      if (exportedAt) fd.append("sourceExportedAtLocal", exportedAt);
      if (exportedAt && exportedAtEstimate) fd.append("sourceExportedAtProvenance", "provisional");
      const upRes = await fetch("/api/admin/import/upload", { method: "POST", body: fd });
      const upData = await upRes.json().catch(() => ({}));
      if (!upRes.ok) {
        setError(upData.error ? describeApiError(upData) : "Upload failed — nothing was imported.");
        return;
      }
      setJob(upData);
      refreshHistory();

      setBusy("preview");
      const prevRes = await fetch(`/api/admin/import/${upData.id}/preview`, { method: "POST" });
      const prevData = await prevRes.json().catch(() => ({}));
      if (!prevRes.ok) {
        setError(prevData.error ? describeApiError(prevData) : "Preview failed — nothing was imported.");
      } else if (prevData.mode === "refresh") {
        setRefreshPreview(prevData);
      } else {
        setPreview(prevData);
      }
      // The history row moves from "Uploaded" to "Previewed" (verifier lane 5).
      refreshHistory();
    } catch {
      setError("Couldn't reach MatFlow — check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!job) return;
    const count = preview?.willImport ?? 0;
    const missingTiers = preview?.teamup2?.exceptions.unmatchedPlanLabels.length ?? 0;
    const ok = refreshPreview
      ? await ask({
          title: `Update ${plural(refreshPreview.willChange, "member", "members")} from TeamUp?`,
          body: "Only status, payment standing and plan change, and every matched member's standing is dated to this export. Contact details, internal notes, medical notes, waivers, holds and guardian links (suggested or confirmed) are never touched. Nobody is created, emailed or charged. You can roll this refresh back from the import history.",
          confirmLabel: "Refresh",
        })
      : await ask({
          title: `Import ${plural(count, "member", "members")}?`,
          body: `Members already on file are matched by email and skipped, never overwritten. Nobody is emailed. Imported members are added straight away; you can roll the import back afterwards for anyone nobody has touched yet.${missingTiers > 0 ? ` ${missingTiers === 1 ? "1 live plan has" : `${missingTiers} live plans have`} no tier yet: those members are imported with the plan name only, and a Status refresh links them once the tiers exist.` : ""}`,
          confirmLabel: "Import",
        });
    if (!ok) return;
    setBusy("commit");
    setError(null);
    try {
      const res = await fetch(`/api/admin/import/${job.id}/commit`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ? describeApiError(data) : "Import failed — see import history for details.");
      } else {
        const refreshed = await fetch(`/api/admin/import/${job.id}`);
        if (refreshed.ok) setJob(await refreshed.json());
        else setError("Imported, but the import record could not be reloaded — refresh the page.");
      }
    } catch {
      setError("Couldn't reach MatFlow, so we don't know whether the import ran. Check the import history before trying again.");
    } finally {
      setBusy(null);
      refreshHistory();
    }
  }

  /**
   * Read the chosen file's header row in the browser. A TeamUp memberships
   * export chosen while the Source is anything else switches the Source to
   * TeamUp and says so (the owner can change it back, but the upload route
   * refuses it); a file meant for the other import is named and the submit
   * button is disabled. The default Source is "Generic CSV", so without this a
   * TeamUp file ran the generic parser and failed with "Couldn't find name or
   * email columns" (3 Oct 2026).
   */
  async function chooseFile(next: File | null) {
    setFile(next);
    setFileKind(null);
    setDetectedNote(null);
    if (!next) return;
    let detected: CsvKind;
    try {
      detected = sniffCsvKind(await next.slice(0, 4096).text());
    } catch {
      return; // Unreadable here: the upload route checks the header again.
    }
    setFileKind(detected);
    if (kind === "members" && detected === "teamup_memberships" && source !== "teamup") {
      setSource("teamup");
      setDetectedNote("Detected a TeamUp memberships export — Source set to TeamUp.");
    }
  }

  function reset() {
    setFile(null);
    setFileKind(null);
    setDetectedNote(null);
    setJob(null);
    setPreview(null);
    setRefreshPreview(null);
    setError(null);
    setInviteResult(null);
  }

  function switchKind(next: Kind) {
    if (next === kind) return;
    reset();
    setExportedAt("");
    setExportedAtEstimate(false);
    setKind(next);
  }

  /** A rollback from the history list: keep the panel's own view of that job honest. */
  async function historyChanged(jobId: string) {
    if (job?.id === jobId) {
      const refreshed = await fetch(`/api/admin/import/${jobId}`).catch(() => null);
      if (refreshed?.ok) setJob(await refreshed.json());
    }
  }

  // After every hook, never before: an early return above them would change
  // the hook order between the loading and the loaded render and React would
  // throw. `loading` is included so the panel does not flash into view for a
  // manager for one frame before the session resolves.
  if (status === "loading" || !isOwner) return null;

  const inProgress = kind === "members" && job !== null;

  // The chosen file belongs to another import path: say which, and do not let it be sent.
  const fileMismatch: string | null =
    kind === "members" && fileKind === "teamup_attendance" ? WRONG_PATH_MESSAGE.attendanceAsMembers
    : kind === "members" && fileKind === "teamup_memberships" && source !== "teamup" ? WRONG_PATH_MESSAGE.membershipsAsOtherSource
    : kind === "attendance" && fileKind === "teamup_memberships" ? WRONG_PATH_MESSAGE.membershipsAsAttendance
    : null;

  const exportedAtField = (
    <div>
      <label htmlFor="import-exported-at" className="block text-xs mb-1 text-tx-3">When was this file exported? Club time (required for TeamUp)</label>
      <input
        id="import-exported-at"
        type="datetime-local"
        value={exportedAt}
        onChange={(e) => setExportedAt(e.target.value)}
        className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border border-bd-default text-tx-1 outline-none"
      />
      <p className="text-[11px] mt-1 text-tx-4">
        The import is only as current as the export — this date is kept with it. Enter the time at the club, wherever you are now.
      </p>
      {kind === "members" && (
        <div className="mt-2 flex items-start gap-2">
          <Checkbox
            id="import-exported-at-estimate"
            checked={exportedAtEstimate}
            onCheckedChange={setExportedAtEstimate}
            aria-describedby="import-exported-at-estimate-hint"
          />
          <div>
            <label htmlFor="import-exported-at-estimate" className="text-xs text-tx-2 cursor-pointer">
              This is an estimate — I will confirm the real export time later
            </label>
            <p id="import-exported-at-estimate-hint" className="text-[11px] text-tx-4">
              The import is marked &ldquo;export time provisional&rdquo;. Once you know the real time, run a Status refresh from the same file with it.
            </p>
          </div>
        </div>
      )}
    </div>
  );

  const fileField = (
    <div>
      <label htmlFor="import-file" className="block text-xs mb-1 text-tx-3">CSV file (max 10MB)</label>
      <input
        id="import-file"
        aria-label="CSV file (max 10MB)"
        required
        type="file"
        accept=".csv,text/csv,application/csv,application/vnd.ms-excel"
        onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)}
        className="w-full text-sm text-tx-2"
      />
      {detectedNote && !fileMismatch && (
        <p role="status" className="text-xs mt-1 font-medium text-tx-1" data-testid="import-source-detected">
          {detectedNote} You can change it back, but a TeamUp file is only imported as TeamUp.
        </p>
      )}
      {fileMismatch && (
        <p role="alert" className="text-xs mt-1 font-medium text-[var(--hue-danger-ink)]" data-testid="import-file-mismatch">
          {fileMismatch}
        </p>
      )}
    </div>
  );

  return (
    // §4a.5: same dark-theme leftover as the sibling panels — 2.5% white over
    // the light staff shell is the light staff shell.
    <div className="rounded-2xl border border-bd-default bg-sf-1 p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-2 text-tx-1">
            <Database className="w-4 h-4" />
            {kind === "members" ? "Member CSV import" : "Attendance history import"}
          </h2>
          <p className="text-xs mt-0.5 text-tx-3">
            {kind === "members"
              ? "Migrate members from MindBody, Glofox, Wodify, or any CSV. Dry-run preview before commit. Existing emails are skipped, never overwritten."
              : "Bring past class attendance across from a TeamUp attendance export, after the members are in. Preview before anything is written."}
          </p>
        </div>
      </div>

      <div role="group" aria-label="What are you importing?" className="mb-4 flex flex-wrap gap-2">
        <Button
          type="button"
          size="compact"
          variant={kind === "members" ? "primary" : "secondary"}
          aria-pressed={kind === "members"}
          disabled={busy !== null}
          onClick={() => switchKind("members")}
          style={kind === "members" ? { background: primaryColor } : undefined}
        >
          Members
        </Button>
        <Button
          type="button"
          size="compact"
          variant={kind === "attendance" ? "primary" : "secondary"}
          aria-pressed={kind === "attendance"}
          disabled={busy !== null}
          onClick={() => switchKind("attendance")}
          style={kind === "attendance" ? { background: primaryColor } : undefined}
        >
          Attendance history
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border border-[color-mix(in_srgb,var(--hue-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--hue-danger)_6%,transparent)] text-[var(--hue-danger-ink)]"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-xs">
            {error}
            {/import history/i.test(error) && (
              <>
                {" "}
                <a href="#import-history" className="underline">Open the import history</a>
              </>
            )}
          </p>
        </div>
      )}

      {inProgress && (
        <div className="mb-4 rounded-xl border border-bd-default bg-sf-2 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-4 h-4 shrink-0 text-tx-3" />
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate text-tx-1">{job?.fileName}</p>
              <p className="text-[11px] text-tx-3">
                {`Source: ${job?.source} · Status: ${job?.status}`}
              </p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="compact" onClick={reset} disabled={busy !== null}>Start over</Button>
        </div>
      )}

      {kind === "members" && !job && (
        <form onSubmit={uploadAndPreview} className="space-y-3">
          <div>
            <label htmlFor="import-source" className="block text-xs mb-1 text-tx-3">Source</label>
            <Select
              id="import-source"
              aria-label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value as Source)}
              className="w-full"
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
            <p className="text-[11px] mt-1 text-tx-4">
              {SOURCES.find((s) => s.value === source)?.hint}
            </p>
          </div>

          {source === "teamup" && (
            <div>
              <div role="group" aria-label="What should this TeamUp file do?" className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="compact"
                  variant={mode === "create" ? "primary" : "secondary"}
                  aria-pressed={mode === "create"}
                  onClick={() => setMode("create")}
                  style={mode === "create" ? { background: primaryColor } : undefined}
                >
                  Add people
                </Button>
                <Button
                  type="button"
                  size="compact"
                  variant={mode === "refresh" ? "primary" : "secondary"}
                  aria-pressed={mode === "refresh"}
                  onClick={() => setMode("refresh")}
                  style={mode === "refresh" ? { background: primaryColor } : undefined}
                >
                  Status refresh
                </Button>
              </div>
              <p className="text-[11px] mt-1 text-tx-4">
                {mode === "create"
                  ? "The first import: creates the people in the file who are not in MatFlow yet."
                  : "A fresh TeamUp export updates status, payment standing and plan for people already imported. Nobody is created; contact details, internal notes, medical notes, waivers, holds and guardian links — suggested or confirmed — are never touched. A file exported before the standing already recorded is refused. The export time is required."}
              </p>
            </div>
          )}

          {fileField}
          {exportedAtField}

          <Button
            type="submit"
            disabled={!file || busy !== null || fileMismatch !== null || (exportedAtEstimate && !exportedAt) || (source === "teamup" && mode === "refresh" && !exportedAt)}
            loading={busy !== null}
            style={{ background: primaryColor }}
          >
            {busy === null && <Upload className="w-4 h-4" />}
            {busy === "upload" ? "Uploading…" : busy === "preview" ? "Parsing preview…" : "Upload + preview"}
          </Button>
        </form>
      )}

      {kind === "members" && job && (
        <div className="space-y-4">
          {refreshPreview && job.status !== "complete" && (
            <RefreshPreviewPanel
              preview={refreshPreview}
              busy={busy === "commit"}
              disabled={busy !== null}
              primaryColor={primaryColor}
              onCommit={() => void commit()}
            />
          )}

          {job.mode === "refresh" && job.status === "complete" && !job.rolledBackAt && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--hue-success)_25%,transparent)] bg-[color-mix(in_srgb,var(--hue-success)_6%,transparent)] p-4" data-testid="refresh-complete">
              <p className="font-semibold text-sm flex items-center gap-2 text-[var(--hue-success-ink)]">
                <CheckCircle2 className="w-4 h-4" />
                Status refresh complete
              </p>
              <p className="text-xs mt-1 text-tx-2">
                {plural(job.manifest?.refresh?.changed ?? 0, "member", "members")} changed, {(job.manifest?.refresh?.unchanged ?? 0).toLocaleString("en-GB")} unchanged
                {job.sourceExportedAt ? `; standing now dated to the TeamUp export of ${formatDateTime(job.sourceExportedAt)}${job.sourceExportedAtProvenance === "provisional" ? " (export time provisional)" : ""}` : ""}.
                {" "}Nobody was created, emailed or charged. Resolve the exceptions below, and roll this refresh back if something looks wrong.
              </p>
              {job.manifest?.refresh?.exceptions && <RefreshExceptionList exceptions={job.manifest.refresh.exceptions} />}
              <div className="mt-3">
                <Button type="button" variant="secondary" size="compact" onClick={() => void rollback()} disabled={rollbackBusy}>
                  {rollbackBusy ? "Rolling back…" : "Roll back this refresh"}
                </Button>
              </div>
            </div>
          )}

          {preview && job.status !== "complete" && (
            <div className="rounded-xl border border-bd-default bg-sf-2 p-4 space-y-3">
              <p className="font-semibold text-sm text-tx-1">Preview</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <Stat label="Total rows" value={preview.totalRows} />
                <Stat label="Will import" value={preview.willImport} tone="success" />
                <Stat label="Existing (skip)" value={preview.existingMatches} />
                <Stat label="Errors" value={preview.errorRows} tone={preview.errorRows > 0 ? "danger" : "muted"} />
              </div>

              {preview.source && (
                <div className="space-y-2" data-testid="import-reconciliation">
                  <p className="text-xs text-tx-2">
                    {plural(preview.source.sourceRows, "TeamUp row", "TeamUp rows")} folded into {plural(preview.source.people, "person", "people")}: {plural(preview.source.adults, "adult", "adults")}, {plural(preview.source.kids, "child", "children")}
                    {preview.source.parentsSynthesised > 0 && ` · ${plural(preview.source.parentsSynthesised, "guardian record", "guardian records")} created from emergency contacts — no login, no access until you confirm each link`}
                    {preview.source.noEmail > 0 && ` · ${preview.source.noEmail} with no email`}
                    {preview.source.sharedEmailAdults > 0 && ` · ${plural(preview.source.sharedEmailAdults, "adult sharing an email", "adults sharing an email")}`}
                    {preview.source.deletedRows > 0 && ` · ${plural(preview.source.deletedRows, "deleted-customer row", "deleted-customer rows")} dropped`}
                    . Live now: {preview.source.currentActive} active, {preview.source.currentOnHold} on hold; {preview.source.historicalOnly} with no live membership.
                    {preview.source.multipleLiveMemberships > 0 && ` ${preview.source.multipleLiveMemberships === 1 ? "1 person shows" : `${preview.source.multipleLiveMemberships} people show`} two live memberships — flagged in their notes for review.`}
                    {preview.source.kidsWithoutParent > 0 && ` ${preview.source.kidsWithoutParent === 1 ? "1 child" : `${preview.source.kidsWithoutParent} children`} could not be linked to a parent and ${preview.source.kidsWithoutParent === 1 ? "was" : "were"} not imported.`}
                    {" "}Next-charge dates are estimates in the notes only — nothing is billed on them.
                  </p>
                  <details>
                    <summary className="text-xs cursor-pointer text-tx-3">Live memberships by plan — compare with TeamUp&apos;s own counts</summary>
                    <table className="mt-2 text-xs w-full">
                      <thead><tr className="text-tx-3"><th className="text-left font-medium pb-1">Plan</th><th className="text-right font-medium pb-1">Active</th><th className="text-right font-medium pb-1">On hold</th></tr></thead>
                      <tbody>
                        {Object.entries(preview.source.planCounts).sort((a, b) => b[1].active - a[1].active).map(([plan, c]) => (
                          <tr key={plan} className="text-tx-2"><td className="py-0.5">{plan}</td><td className="text-right tabular-nums">{c.active}</td><td className="text-right tabular-nums">{c.hold}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>
              )}

              {preview.teamup2 && <TeamUpFacts jobId={job.id} facts={preview.teamup2} />}

              {preview.sampleDrafts.length > 0 && (
                <details>
                  <summary className="text-xs cursor-pointer text-tx-3">First {plural(preview.sampleDrafts.length, "member", "members")}</summary>
                  <ul className="mt-2 text-xs space-y-1">
                    {preview.sampleDrafts.map((d, i) => (
                      <li key={`${d.email}-${i}`} className="text-tx-2">
                        <strong>{d.name}</strong> · {d.email}
                        {d.membershipType ? ` · ${d.membershipType}` : ""}
                        {d.paymentStatus ? ` · ${d.paymentStatus}` : ""}
                        {d.nextDueAt ? ` · next due ${d.nextDueAt}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {preview.sampleErrors.length > 0 && (
                <details>
                  <summary className="text-xs cursor-pointer text-[var(--hue-danger-ink)]">{plural(preview.sampleErrors.length, "sample error", "sample errors")}</summary>
                  <ul className="mt-2 text-xs space-y-1">
                    {preview.sampleErrors.map((e, i) => (
                      <li key={i} className="text-[var(--hue-danger-ink)]">Row {e.row}: {e.reason}</li>
                    ))}
                  </ul>
                </details>
              )}

              {(preview.teamup2?.exceptions.unmatchedPlanLabels.length ?? 0) > 0 && (
                <div
                  role="alert"
                  data-testid="import-missing-tiers"
                  className="rounded-xl border border-[color-mix(in_srgb,var(--hue-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--hue-warning)_8%,transparent)] p-3 text-xs text-tx-1 space-y-1"
                >
                  <p className="font-semibold">
                    Create the missing tiers first: {plural(preview.teamup2!.exceptions.unmatchedPlanLabels.length, "plan", "plans")} that members are on now, start soon or are on hold on {preview.teamup2!.exceptions.unmatchedPlanLabels.length === 1 ? "has" : "have"} no MatFlow tier.
                  </p>
                  <ul className="list-disc ml-4">
                    {preview.teamup2!.exceptions.unmatchedPlanLabels.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                  <p className="text-tx-2">
                    Add each under Memberships with exactly this name, then start over and upload the file again. You can still import now: those members keep the plan name as text with no tier, and a Status refresh links them once the tiers exist.
                  </p>
                </div>
              )}

              <Button
                type="button"
                onClick={() => void commit()}
                disabled={busy !== null || preview.willImport === 0}
                loading={busy === "commit"}
                style={{ background: primaryColor }}
              >
                {busy !== "commit" && <CheckCircle2 className="w-4 h-4" />}
                {busy === "commit" ? "Importing…" : `Import ${plural(preview.willImport, "member", "members")}`}
              </Button>
            </div>
          )}

          {job.mode !== "refresh" && job.status === "complete" && job.rolledBackAt && (
            <div className="rounded-xl border border-bd-default bg-sf-2 p-4" data-testid="import-rolled-back">
              <p className="font-semibold text-sm text-tx-1">
                Rolled back — {plural(job.manifest?.rollback?.removed ?? 0, "member", "members")} removed
              </p>
              {(job.manifest?.rollback?.kept.length ?? 0) > 0 && (
                <details className="mt-2" open>
                  <summary className="text-xs cursor-pointer text-tx-2">
                    {job.manifest!.rollback!.kept.length} kept because someone had already used them
                  </summary>
                  <ul className="mt-2 text-xs space-y-1">
                    {job.manifest!.rollback!.kept.map((k) => (
                      <li key={k.memberId} className="text-tx-2"><strong>{k.name}</strong> — {k.reasons.join(", ")}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {job.mode !== "refresh" && job.status === "complete" && !job.rolledBackAt && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--hue-success)_25%,transparent)] bg-[color-mix(in_srgb,var(--hue-success)_6%,transparent)] p-4">
              <p className="font-semibold text-sm flex items-center gap-2 text-[var(--hue-success-ink)]">
                <CheckCircle2 className="w-4 h-4" />
                Import complete
              </p>
              {job.manifest?.created && (
                <p className="text-xs mt-1 text-tx-2" data-testid="import-commit-reconciliation">
                  {job.manifest.reconciles
                    ? "Every person in the file is accounted for: created, already here, or listed as an error."
                    : "Warning: the counts below do not add up to the people in the file — check the errors before relying on this import."}
                  {job.sourceExportedAt ? ` Source exported ${formatDateTime(job.sourceExportedAt)}${job.sourceExportedAtProvenance === "provisional" ? " — export time provisional (an estimate): run a Status refresh with the real export time to confirm it" : ""}.` : ""}
                  {job.manifest.created.unmatchedPlan > 0
                    ? ` ${job.manifest.created.unmatchedPlan === 1 ? "1 member has" : `${job.manifest.created.unmatchedPlan} members have`} a plan name with no matching membership tier yet.`
                    : ""}
                </p>
              )}
              <div className="grid grid-cols-3 gap-3 mt-3">
                <Stat label="Imported" value={job.importedRows} tone="success" />
                <Stat label="Skipped" value={job.skippedRows} tone="warning" />
                <Stat label="Errors" value={job.errorRows} tone={job.errorRows > 0 ? "danger" : "muted"} />
              </div>
              {job.manifest?.teamup2 && <TeamUpFacts jobId={job.id} facts={job.manifest.teamup2} committed />}
              {/* Imported members have no password and can't self-recover
                  (magic-link + forgot-password both require one) — invites are
                  the only door in. */}
              <div className="mt-4 pt-3 border-t border-[color-mix(in_srgb,var(--hue-success)_15%,transparent)]">
                {inviteResult ? (
                  <p className="text-xs text-tx-2">{inviteResult}</p>
                ) : (
                  <>
                    <Button type="button" size="compact" onClick={() => void sendInvites()} disabled={inviteBusy} loading={inviteBusy} style={{ background: primaryColor }}>
                      {inviteBusy ? "Sending invites…" : "Send login invites to imported members"}
                    </Button>
                    <p className="text-[11px] mt-1.5 text-tx-4">
                      Emails every adult member who has no login yet a 7-day set-password link. Kids stay passwordless.
                    </p>
                  </>
                )}
              </div>
              <div className="mt-3">
                <Button type="button" variant="secondary" size="compact" onClick={() => void rollback()} disabled={rollbackBusy}>
                  {rollbackBusy ? "Rolling back…" : "Roll back this import"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {kind === "attendance" && <AttendanceImport primaryColor={primaryColor} onChanged={refreshHistory} />}

      <ImportHistory refreshKey={historyKey} onChanged={(id) => void historyChanged(id)} />

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

/**
 * teamup-2: the as-of date, the row ledger, and every decision the owner must
 * make — before the commit (preview) and after it (manifest). Names are the
 * owner's own members. The CSV download is the same list.
 */
function TeamUpFacts({ jobId, facts, committed = false }: { jobId: string; facts: TeamUp2Facts; committed?: boolean }) {
  const rows = facts.exceptionRows ?? [];
  const counts = countByKind(rows);
  const kinds = (Object.keys(EXCEPTION_WORDS) as (keyof typeof EXCEPTION_WORDS)[]).filter((k) => counts[k] > 0);
  const toDecide = counts.decision_required + counts.guardian_suggested + counts.guardian_draft + counts.plan_without_tier;
  return (
    <div className="space-y-2 text-xs text-tx-2" data-testid="teamup-facts">
      <p>
        Standing is read <strong>as of {formatDate(facts.asOf)}</strong>
        {facts.asOfProvenance === "provisional"
          ? " — export time provisional: the time you entered is an estimate. Once you know the real export time, run a Status refresh from the same file with it; standing is re-read as of that date."
          : facts.asOfIsProvisional
            ? " — the file carries no export time, so this is the upload date; enter the export time if a membership starts or ends around it."
            : " (the export time you entered)."}
        {" "}{plural(facts.ledger.rows, "source row", "source rows")} each kept with its own disposition
        {committed && facts.ledger.persisted != null ? ` (${facts.ledger.persisted.toLocaleString("en-GB")} stored as membership history)` : ""}.
      </p>
      {rows.length === 0 ? (
        <p className="font-medium text-tx-1">Nothing to decide: every person has one current plan, every guardian link was made by staff, and every plan has a tier.</p>
      ) : (
        <>
          <p className="font-semibold text-tx-1">
            {plural(toDecide, "item needs", "items need")} your decision{committed ? "" : " (nothing is written until you import)"}; {plural(rows.length - toDecide, "item is", "items are")} for your information.
          </p>
          <ul className="space-y-1" data-testid="teamup-exceptions">
            {kinds.map((k) => (
              <li key={k}>
                <strong>{counts[k].toLocaleString("en-GB")}</strong> · {EXCEPTION_WORDS[k].title} — {EXCEPTION_WORDS[k].action}
                {k === "decision_required" && facts.decisions.length > 0 && (
                  <ul className="ml-4 mt-0.5 list-disc">
                    {facts.decisions.slice(0, 10).map((d, i) => <li key={i}><strong>{d.name}</strong>: {d.options.join(" or ")}</li>)}
                  </ul>
                )}
                {k === "scheduled_start" && facts.scheduled.length > 0 && (
                  <ul className="ml-4 mt-0.5 list-disc">
                    {facts.scheduled.slice(0, 10).map((s, i) => <li key={i}><strong>{s.name}</strong>: {s.planLabel} from {formatDate(s.startDate)}</li>)}
                  </ul>
                )}
                {k === "plan_without_tier" && facts.exceptions.unmatchedPlanLabels.length > 0 && (
                  <span> (live: {facts.exceptions.unmatchedPlanLabels.join(", ")})</span>
                )}
                {k === "plan_without_tier" && (facts.exceptions.unmatchedHistoryPlanLabels?.length ?? 0) > 0 && (
                  <span> (history only, no tier needed: {facts.exceptions.unmatchedHistoryPlanLabels!.join(", ")})</span>
                )}
              </li>
            ))}
          </ul>
          <a
            href={`/api/admin/import/${jobId}/exceptions`}
            className="inline-flex items-center gap-1 font-medium underline text-tx-1"
            download
          >
            Download the full list as CSV ({plural(rows.length, "row", "rows")})
          </a>
        </>
      )}
      <p>Guardian links suggested by the import give the parent <strong>no access</strong> until you confirm them on the child&apos;s Family card. Nobody is emailed, charged or subscribed by an import.</p>
    </div>
  );
}

function RefreshExceptionList({ exceptions }: { exceptions: RefreshExceptions }) {
  const holdKept = exceptions.holdKept ?? [];
  const total = exceptions.notInMatFlow.length + exceptions.notInFile.length + exceptions.billedByMatFlow.length + exceptions.refused.length + holdKept.length;
  if (total === 0) return <p className="mt-2 text-xs text-tx-2">No exceptions: everyone in the file matched, and everyone TeamUp bills is in the file.</p>;
  return (
    <div className="mt-2 space-y-2 text-xs text-tx-2" data-testid="refresh-exceptions">
      <p className="font-semibold text-tx-1">{plural(total, "exception", "exceptions")} to resolve</p>
      {exceptions.notInMatFlow.length > 0 && (
        <details open>
          <summary className="cursor-pointer">
            {plural(exceptions.notInMatFlow.length, "person", "people")} in the file with no matching member — new at TeamUp, or their name or email changed there. Nobody is created or matched by a guess.
          </summary>
          <ul className="mt-1 space-y-0.5">
            {exceptions.notInMatFlow.map((e, i) => (
              <li key={`${e.name}-${i}`}><strong>{e.name}</strong>{e.email ? ` · ${e.email}` : " · no email"}</li>
            ))}
          </ul>
        </details>
      )}
      {exceptions.notInFile.length > 0 && (
        <details open>
          <summary className="cursor-pointer">
            {plural(exceptions.notInFile.length, "member", "members")} billed by TeamUp but not in this file — left as they were. Check whether they were deleted at TeamUp or left out of the export.
          </summary>
          <ul className="mt-1 space-y-0.5">
            {exceptions.notInFile.map((e) => <li key={e.memberId}><strong>{e.name}</strong></li>)}
          </ul>
        </details>
      )}
      {holdKept.length > 0 && (
        <div>
          <p className="text-xs font-semibold" style={{ color: "var(--tx-1)" }}>
            {plural(holdKept.length, "member", "members")} on hold in MatFlow while TeamUp says they are not — the hold is kept. If the hold has ended, resume them from their profile.
          </p>
          <ul className="mt-1 text-xs" style={{ color: "var(--tx-2)" }}>
            {holdKept.map((e) => <li key={e.memberId}><strong>{e.name}</strong> — TeamUp: {e.teamUpSays}</li>)}
          </ul>
        </div>
      )}
      {exceptions.billedByMatFlow.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {plural(exceptions.billedByMatFlow.length, "member", "members")} now billed by MatFlow — a TeamUp file does not change their standing.
          </summary>
          <ul className="mt-1 space-y-0.5">
            {exceptions.billedByMatFlow.map((e) => <li key={e.memberId}><strong>{e.name}</strong></li>)}
          </ul>
        </details>
      )}
      {exceptions.refused.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[var(--hue-danger-ink)]">
            {plural(exceptions.refused.length, "row", "rows")} in the file could not be read
          </summary>
          <ul className="mt-1 space-y-0.5">
            {exceptions.refused.map((e, i) => <li key={i} className="text-[var(--hue-danger-ink)]">Row {e.row}: {e.reason}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

export function RefreshPreviewPanel({
  preview,
  busy,
  disabled,
  primaryColor,
  onCommit,
}: {
  preview: RefreshPreview;
  busy: boolean;
  disabled: boolean;
  primaryColor: string;
  onCommit: () => void;
}) {
  return (
    <div className="rounded-xl border border-bd-default bg-sf-2 p-4 space-y-3" data-testid="refresh-preview">
      <p className="font-semibold text-sm text-tx-1">Status refresh preview — nothing has changed yet</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <Stat label="Rows in file" value={preview.totalRows} />
        <Stat label="Matched" value={preview.matched} />
        <Stat label="Will change" value={preview.willChange} tone="success" />
        <Stat label="Unchanged" value={preview.unchanged} tone="muted" />
      </div>
      {!preview.reconciles && (
        <p className="text-xs text-[var(--hue-danger-ink)]">Warning: these counts do not add up to the people in the file.</p>
      )}
      {preview.changes.length > 0 && (
        <details open={preview.changes.length <= 20}>
          <summary className="text-xs cursor-pointer text-tx-3">What changes, person by person</summary>
          <ul className="mt-2 text-xs space-y-1" data-testid="refresh-changes">
            {preview.changes.map((c) => (
              <li key={c.memberId} className="text-tx-2">
                <strong>{c.name}</strong>
                {c.fields.map((f) => (
                  <span key={f.field}>
                    {" · "}{REFRESH_FIELD_WORDS[f.field] ?? f.field}: {refreshValue(f.field, f.before)} → {refreshValue(f.field, f.after)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
      <RefreshExceptionList exceptions={preview.exceptions} />
      <p className="text-xs font-medium text-tx-1">
        A refresh changes only status, payment standing and plan. It never creates anyone, sends anything or charges anyone.
      </p>
      <Button
        type="button"
        onClick={onCommit}
        disabled={disabled || preview.matched === 0}
        loading={busy}
        style={{ background: primaryColor }}
      >
        {!busy && <CheckCircle2 className="w-4 h-4" />}
        {busy ? "Refreshing…" : `Refresh ${plural(preview.matched, "member", "members")}`}
      </Button>
    </div>
  );
}

const TONE_CLASS = {
  default: "text-tx-1",
  success: "text-[var(--hue-success-ink)]",
  warning: "text-[var(--hue-warning-ink)]",
  danger: "text-[var(--hue-danger-ink)]",
  muted: "text-tx-3",
} as const;

function Stat({ label, value, tone = "default" }: { label: string; value: number; tone?: keyof typeof TONE_CLASS }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-tx-4">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${TONE_CLASS[tone]}`}>{value}</p>
    </div>
  );
}
