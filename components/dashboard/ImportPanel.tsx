"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Upload, FileText, CheckCircle2, AlertCircle, Database } from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import ImportHistory, { plural } from "@/components/dashboard/ImportHistory";
import { describeApiError } from "@/lib/api-field-errors";
import { formatDate, formatDateTime } from "@/lib/date";

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
  mappingVersion?: string | null;
  rolledBackAt?: string | null;
  manifest?: {
    reconciles?: boolean;
    mode?: Mode;
    refresh?: { changed: number; unchanged: number; exceptions: RefreshExceptions };
    created?: { total: number; unmatchedPlan: number };
    rollback?: { removed: number; kept: { memberId: string; name: string; reasons: string[] }[] };
  } | null;
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
};

type RefreshExceptions = {
  notInMatFlow: { name: string; email: string | null; rows?: number[] }[];
  notInFile: { memberId: string; name: string }[];
  billedByMatFlow: { memberId: string; name: string }[];
  refused: { row: number; reason: string }[];
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

/** POST admin/import/attendance mode=preview → `summary`. */
type AttendanceSummary = {
  inputRows: number;
  toImport: number;
  sessions: number;
  quarantined: number;
  excluded: number;
  duplicates: number;
  quarantinedByReason: Record<string, number>;
  excludedByReason: Record<string, number>;
  reconciles: boolean;
};

/** POST admin/import/attendance mode=commit → `manifest`. */
type AttendanceManifest = {
  input?: { rows: number };
  created: { total: number };
  alreadyPresent: number;
  quarantined: { total: number; byReason: Record<string, number> };
  excluded: { total: number; byReason: Record<string, number>; duplicates: number };
  sessions?: { created: number };
  reconciles: boolean;
};

/** Why a row is held back for the owner to look at (lib/importers/attendance QuarantineReason). */
const QUARANTINE_WORDS: Record<string, string> = {
  missing_date: "no date",
  missing_time: "no time",
  malformed_date: "a date that could not be read",
  offset_not_supported: "a time with a timezone offset",
  nonexistent_local_time: "a time the clocks skipped",
  missing_status: "no status",
  unknown_status: "a status MatFlow does not recognise",
  conflicting_status: "conflicting statuses",
  no_person_key: "no name, email or ID",
  unresolved_person: "nobody in MatFlow matches",
  ambiguous_email: "an email shared by more than one member",
  email_name_mismatch: "the email and name point to different members",
  missing_class: "no class name",
  unknown_class: "no class in MatFlow with that name",
  ambiguous_class: "more than one class matches",
  future_session: "the session has not happened yet",
};

/** Why a row is not attendance at all (ExclusionReason). */
const EXCLUSION_WORDS: Record<string, string> = {
  booked: "booked but never checked in",
  cancelled: "cancelled",
  late_cancel: "late cancellation",
  no_show: "no-show",
  waitlisted: "waitlisted",
  not_attended: "did not attend",
  duplicate: "duplicate row",
};

function reasonsInWords(byReason: Record<string, number>, words: Record<string, string>): string {
  return Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n.toLocaleString("en-GB")} ${words[reason] ?? reason.replace(/_/g, " ")}`)
    .join(", ");
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
  const [job, setJob] = useState<Job | null>(null);
  const [mode, setMode] = useState<Mode>("create");
  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);
  const [busy, setBusy] = useState<"upload" | "preview" | "commit" | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<string | null>(null);
  const { ask, dialogProps } = useConfirmDialog();

  // Attendance-history import (app/api/admin/import/attendance).
  const [attPreview, setAttPreview] = useState<{ jobId: string; fileName: string; summary: AttendanceSummary } | null>(null);
  const [attManifest, setAttManifest] = useState<AttendanceManifest | null>(null);

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
      body: "Removes the members this import created, as long as nobody has touched them since — anyone who has signed in, checked in, paid, signed a waiver or been edited is kept, and you will see who and why. This cannot be undone.",
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
      if (exportedAt) fd.append("sourceExportedAt", new Date(exportedAt).toISOString());
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
    const ok = refreshPreview
      ? await ask({
          title: `Update ${plural(refreshPreview.willChange, "member", "members")} from TeamUp?`,
          body: "Only status, payment standing and plan change, and every matched member's standing is dated to this export. Contact details, medical notes, waivers, holds and notes are never touched. Nobody is created, emailed or charged. You can roll this refresh back from the import history.",
          confirmLabel: "Refresh",
        })
      : await ask({
          title: `Import ${plural(count, "member", "members")}?`,
          body: "Members already on file are matched by email and skipped, never overwritten. Nobody is emailed. Imported members are added straight away; you can roll the import back afterwards for anyone nobody has touched yet.",
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

  async function attendanceUploadAndPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy("preview");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("mode", "preview");
      fd.append("file", file);
      if (exportedAt) fd.append("sourceExportedAt", new Date(exportedAt).toISOString());
      const res = await fetch("/api/admin/import/attendance", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.jobId || !data.summary) {
        setError(data.error ? describeApiError(data) : "Preview failed — nothing was imported.");
        return;
      }
      setAttPreview({ jobId: data.jobId, fileName: file.name, summary: data.summary });
      refreshHistory();
    } catch {
      setError("Couldn't reach MatFlow — check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function attendanceCommit() {
    if (!attPreview) return;
    const n = attPreview.summary.toImport;
    const ok = await ask({
      title: `Import ${plural(n, "attendance record", "attendance records")}?`,
      body: "These are written as past visits only. Nobody is charged, nobody is notified and no class credits are used. A record MatFlow already has is left as it is. You can roll the import back from the import history.",
      confirmLabel: "Import",
    });
    if (!ok) return;
    setBusy("commit");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("mode", "commit");
      fd.append("jobId", attPreview.jobId);
      const res = await fetch("/api/admin/import/attendance", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.manifest) {
        setError(data.error ? describeApiError(data) : "Import failed — see import history for details.");
        return;
      }
      setAttManifest(data.manifest);
    } catch {
      setError("Couldn't reach MatFlow, so we don't know whether the import ran. Check the import history before trying again.");
    } finally {
      setBusy(null);
      refreshHistory();
    }
  }

  function reset() {
    setFile(null);
    setJob(null);
    setPreview(null);
    setRefreshPreview(null);
    setAttPreview(null);
    setAttManifest(null);
    setError(null);
    setInviteResult(null);
  }

  function switchKind(next: Kind) {
    if (next === kind) return;
    reset();
    setExportedAt("");
    setKind(next);
  }

  /** A rollback from the history list: keep the panel's own view of that job honest. */
  async function historyChanged(jobId: string) {
    if (job?.id === jobId) {
      const refreshed = await fetch(`/api/admin/import/${jobId}`).catch(() => null);
      if (refreshed?.ok) setJob(await refreshed.json());
    }
    if (attPreview?.jobId === jobId) reset();
  }

  // After every hook, never before: an early return above them would change
  // the hook order between the loading and the loaded render and React would
  // throw. `loading` is included so the panel does not flash into view for a
  // manager for one frame before the session resolves.
  if (status === "loading" || !isOwner) return null;

  const inProgress = kind === "members" ? job !== null : attPreview !== null;

  const exportedAtField = (
    <div>
      <label htmlFor="import-exported-at" className="block text-xs mb-1 text-tx-3">When was this file exported? (recommended)</label>
      <input
        id="import-exported-at"
        type="datetime-local"
        value={exportedAt}
        onChange={(e) => setExportedAt(e.target.value)}
        className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border border-bd-default text-tx-1 outline-none"
      />
      <p className="text-[11px] mt-1 text-tx-4">
        The import is only as current as the export — this date is kept with it.
      </p>
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
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="w-full text-sm text-tx-2"
      />
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
              <p className="text-sm font-semibold truncate text-tx-1">{kind === "members" ? job?.fileName : attPreview?.fileName}</p>
              <p className="text-[11px] text-tx-3">
                {kind === "members"
                  ? `Source: ${job?.source} · Status: ${job?.status}`
                  : attManifest ? "Attendance history · imported" : "Attendance history · previewed, not imported yet"}
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
                  : "A fresh TeamUp export updates status, payment standing and plan for people already imported. Nobody is created; contact details, medical notes, waivers and holds are never touched. The export time is required."}
              </p>
            </div>
          )}

          {fileField}
          {exportedAtField}

          <Button
            type="submit"
            disabled={!file || busy !== null || (source === "teamup" && mode === "refresh" && !exportedAt)}
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
                {job.sourceExportedAt ? `; standing now dated to the TeamUp export of ${formatDateTime(job.sourceExportedAt)}` : ""}.
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
                    {preview.source.parentsSynthesised > 0 && ` · ${plural(preview.source.parentsSynthesised, "payer/guardian record", "payer/guardian records")} created from emergency contacts — unverified, not invited`}
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
                  {job.sourceExportedAt ? ` Source exported ${formatDateTime(job.sourceExportedAt)}.` : ""}
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

      {kind === "attendance" && !attPreview && (
        <form onSubmit={attendanceUploadAndPreview} className="space-y-3">
          <p className="text-[11px] text-tx-4">
            TeamUp attendance export, one row per booking or visit. People are matched to members already in MatFlow, and classes to your timetable by name.
          </p>
          {fileField}
          {exportedAtField}
          <Button type="submit" disabled={!file || busy !== null} loading={busy !== null} style={{ background: primaryColor }}>
            {busy === null && <Upload className="w-4 h-4" />}
            {busy === "preview" ? "Checking the file…" : "Upload + preview"}
          </Button>
        </form>
      )}

      {kind === "attendance" && attPreview && !attManifest && (
        <AttendancePreview
          summary={attPreview.summary}
          busy={busy === "commit"}
          disabled={busy !== null}
          primaryColor={primaryColor}
          onCommit={() => void attendanceCommit()}
        />
      )}

      {kind === "attendance" && attManifest && (
        <div
          className="rounded-xl border border-[color-mix(in_srgb,var(--hue-success)_25%,transparent)] bg-[color-mix(in_srgb,var(--hue-success)_6%,transparent)] p-4 space-y-2"
          data-testid="attendance-import-complete"
        >
          <p className="font-semibold text-sm flex items-center gap-2 text-[var(--hue-success-ink)]">
            <CheckCircle2 className="w-4 h-4" />
            Attendance history imported
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Imported" value={attManifest.created.total} tone="success" />
            <Stat label="Already present" value={attManifest.alreadyPresent} tone="muted" />
            <Stat label="Held back" value={attManifest.quarantined.total} tone={attManifest.quarantined.total > 0 ? "warning" : "muted"} />
          </div>
          <p className="text-xs text-tx-2">
            {plural(attManifest.created.total, "attendance record", "attendance records")} written
            {attManifest.sessions && attManifest.sessions.created > 0 ? `, with ${plural(attManifest.sessions.created, "past class session", "past class sessions")} added to hold them` : ""}.
            {attManifest.alreadyPresent > 0 && ` ${plural(attManifest.alreadyPresent, "record was", "records were")} already in MatFlow and left as they were.`}
            {attManifest.quarantined.total > 0 && ` ${plural(attManifest.quarantined.total, "row", "rows")} held back: ${reasonsInWords(attManifest.quarantined.byReason, QUARANTINE_WORDS)}.`}
            {attManifest.excluded.total > 0 && ` ${plural(attManifest.excluded.total, "row was not attendance", "rows were not attendance")}: ${reasonsInWords(attManifest.excluded.byReason, EXCLUSION_WORDS)}.`}
          </p>
          <p className="text-xs text-tx-2" data-testid="attendance-commit-reconciliation">
            {attManifest.reconciles
              ? "Every row is accounted for: imported, already here, held back or excluded, each with its reason."
              : "Warning: the counts do not add up to the rows in the file — check the import history before relying on this import."}
          </p>
          <p className="text-[11px] text-tx-4">Nobody was charged or notified and no class credits were used. Roll it back from the import history below if something looks wrong.</p>
        </div>
      )}

      <ImportHistory refreshKey={historyKey} onChanged={(id) => void historyChanged(id)} />

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

function RefreshExceptionList({ exceptions }: { exceptions: RefreshExceptions }) {
  const total = exceptions.notInMatFlow.length + exceptions.notInFile.length + exceptions.billedByMatFlow.length + exceptions.refused.length;
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

function AttendancePreview({
  summary,
  busy,
  disabled,
  primaryColor,
  onCommit,
}: {
  summary: AttendanceSummary;
  busy: boolean;
  disabled: boolean;
  primaryColor: string;
  onCommit: () => void;
}) {
  return (
    <div className="rounded-xl border border-bd-default bg-sf-2 p-4 space-y-3" data-testid="attendance-preview">
      <p className="font-semibold text-sm text-tx-1">Preview</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <Stat label="Rows in file" value={summary.inputRows} />
        <Stat label="Will import" value={summary.toImport} tone="success" />
        <Stat label="Held back" value={summary.quarantined} />
        <Stat label="Not attendance" value={summary.excluded} tone="muted" />
      </div>
      <p className="text-xs text-tx-2">
        {plural(summary.toImport, "attendance record", "attendance records")} to import across {plural(summary.sessions, "past class session", "past class sessions")}.
        {summary.excluded > 0 && ` ${plural(summary.excluded, "row is", "rows are")} not attendance and will be left out: ${reasonsInWords(summary.excludedByReason, EXCLUSION_WORDS)}.`}
        {summary.quarantined > 0 && ` ${plural(summary.quarantined, "row is", "rows are")} held back for you to check: ${reasonsInWords(summary.quarantinedByReason, QUARANTINE_WORDS)}.`}
        {summary.duplicates > 0 && ` ${plural(summary.duplicates, "duplicate row was", "duplicate rows were")} folded into one.`}
      </p>
      <p className="text-xs text-tx-2">
        {summary.reconciles
          ? "Every row in the file is accounted for."
          : "Warning: these counts do not add up to the rows in the file."}
      </p>
      <p className="text-xs font-medium text-tx-1">
        Imported history never charges anyone, never sends a notification and never uses a class credit.
      </p>
      <Button
        type="button"
        onClick={onCommit}
        disabled={disabled || summary.toImport === 0}
        loading={busy}
        style={{ background: primaryColor }}
      >
        {!busy && <CheckCircle2 className="w-4 h-4" />}
        {busy ? "Importing…" : `Import ${plural(summary.toImport, "attendance record", "attendance records")}`}
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
