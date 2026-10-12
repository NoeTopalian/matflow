"use client";

// Guided "Resolve conflict" for the owner's login address (admin hub lane F,
// 9 Oct 2026; ledger AH-04, story I3). Rendered by the operator Login email
// card when POST /api/admin/customers/[id]/login-email/check says a MEMBER of
// the club holds the address the owner should sign in with.
//
//   1. Review: club, owner and the holder (status, whether they can sign in,
//      a link). A matching name is not proof: the operator must tick that the
//      relationship was verified independently (call-back to the club) and
//      say how — that note goes into the audit reason.
//   2. "Change this member's contact address" (dialog): new address, reason,
//      authenticator code → grant for member.contact_email bound to this
//      member and this address → POST …/members/[memberId]/contact-email.
//   3. Automatic re-check of the owner's address (a read).
//   4. "Change the owner's login address" (dialog): a SEPARATE fresh code →
//      the existing owner login-email route with its own grant.
//   5. Result: each step with its outcome and ids.
//
// Two separate transactions, stated honestly: if step 1 succeeded and step 2
// did not, the panel says so and offers "Resume". The resume point lives in
// the URL (?resolve=owner&member=<id> — ids only) and the address in this
// tab's sessionStorage, so a reload resumes at the owner step with a FRESH
// check. A mutation is never retried automatically; after a lost response the
// operator may re-send the SAME grant (the routes answer "already applied"
// instead of changing anything twice). Every button is disabled while a
// request is in flight.
//
// Staff accounts and duplicates (12 Oct 2026, hub conflict resolution task 4):
// a non-owner STAFF account holding the address moves the same way, through
// "Change this staff account's login address" (grant for staff.login_email
// bound to that account and that address → POST …/staff/[userId]/login-email;
// the person is signed out everywhere). A legacy DUPLICATE lists every holder,
// each with its own move button; after each move the address is checked again
// and the list returns while anything still holds it — the owner step opens
// only once it is free. Any re-check that is still held by records that can
// be moved (after a move, "Check again", or a panel resumed after a reload)
// returns to that list, so the remaining holders are never a dead end; the
// resume trail keeps the ids of earlier moves. Every holder is labelled in plain words
// (record-kind.ts): a club sign-in account (owner/staff) or a member record,
// with a note when a member record merely shares the owner's name. The resume
// point gains &staff=<id> for the staff path (ids only, as before).

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { adminPalette, adminPill } from "@/app/admin/admin-theme";
import { describeRecordKind, sameNameNote } from "@/components/admin/record-kind";

export const STEP_UP_HEADER = "x-matflow-step-up";
const REASON_MIN = 10;

export type CheckedHolder =
  | {
      kind: "member" | "user";
      id: string;
      name: string;
      status: string;
      canSignIn: boolean;
      access: "password" | "activation_pending" | "none";
      link: string;
      version?: string;
    }
  | { kind: "many"; count: number; holders: Array<Exclude<CheckedHolder, { kind: "many" }>> };

type SingleHolder = Exclude<CheckedHolder, { kind: "many" }>;

export type CheckResult = {
  free: boolean;
  sameAsOwner?: boolean;
  tenant: { id: string; name: string };
  owner: { id: string; name: string };
  holder?: CheckedHolder;
};

/** POST …/login-email/check. Never throws; an HTTP error is an error, not "free". */
export async function checkLoginAddress(
  tenantId: string,
  email: string,
): Promise<{ ok: true; data: CheckResult } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/admin/customers/${tenantId}/login-email/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || typeof data.free !== "boolean") {
      return { ok: false, error: data?.error ?? "The address could not be checked. Try again." };
    }
    return { ok: true, data: data as CheckResult };
  } catch {
    return { ok: false, error: "Network error. The address was not checked; try again." };
  }
}

// ── Resume state: ids in the URL, the address in this tab only ─────────────
export type MemberStepResult = { memberId: string; canSignIn: boolean; retired?: { resetCodes: number; signInLinks: number }; alreadyApplied?: boolean };
export type StaffStepResult = { userId: string; retired?: { resetCodes: number; signInLinks: number }; alreadyApplied?: boolean };
export type ResumeState = {
  address: string;
  memberId?: string;
  memberName?: string;
  member?: MemberStepResult;
  staffId?: string;
  staffName?: string;
  staff?: StaffStepResult;
};

const storageKey = (tenantId: string) => `matflow.hub.resolve.${tenantId}`;

export function loadResume(tenantId: string): { urlMemberId: string | null; urlStaffId?: string; state: ResumeState | null } {
  let urlMemberId: string | null = null;
  let urlStaffId: string | undefined;
  let state: ResumeState | null = null;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("resolve") === "owner") {
      urlMemberId = q.get("member");
      urlStaffId = q.get("staff") ?? undefined;
    }
  } catch {
    /* no URL access */
  }
  try {
    const raw = window.sessionStorage.getItem(storageKey(tenantId));
    state = raw ? (JSON.parse(raw) as ResumeState) : null;
  } catch {
    state = null;
  }
  if (state && urlMemberId && state.memberId !== urlMemberId) state = null;
  if (state && urlStaffId && state.staffId !== urlStaffId) state = null;
  return { urlMemberId, urlStaffId, state: urlMemberId || urlStaffId ? state : null };
}

function saveResume(tenantId: string, s: ResumeState) {
  try {
    window.sessionStorage.setItem(storageKey(tenantId), JSON.stringify(s));
  } catch {
    /* storage blocked: the URL still says where to resume */
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("resolve", "owner");
    if (s.memberId) url.searchParams.set("member", s.memberId);
    else url.searchParams.delete("member");
    if (s.staffId) url.searchParams.set("staff", s.staffId);
    else url.searchParams.delete("staff");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* no history access */
  }
}

export function clearResume(tenantId: string) {
  try {
    window.sessionStorage.removeItem(storageKey(tenantId));
  } catch {
    /* ignore */
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("resolve");
    url.searchParams.delete("member");
    url.searchParams.delete("staff");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* ignore */
  }
}

async function requestGrant(body: { action: string; targetId: string; change: Record<string, string>; code: string }) {
  try {
    const res = await fetch("/api/admin/auth/step-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data?.grant !== "string") {
      return { ok: false as const, error: String(data?.error ?? "Your authenticator code was not accepted.") };
    }
    return { ok: true as const, grant: data.grant as string };
  } catch {
    return { ok: false as const, error: "Network error. Your code was not used; try again with the next code." };
  }
}

type Pending = { kind: "member" | "staff" | "owner"; url: string; grant: string; body: Record<string, unknown> };
type OwnerStepResult = { ownerId: string; provisional: boolean; alreadyApplied?: boolean };
type Phase = "review" | "rechecking" | "owner_step" | "blocked" | "done";
/** A record moved off the address in this resolution (step 1, possibly several for a duplicate). */
type Moved = { kind: "member"; result: MemberStepResult } | { kind: "user"; result: StaffStepResult };

function movedFromResume(r: ResumeState | null | undefined): Moved[] {
  if (!r) return [];
  const out: Moved[] = [];
  if (r.member || r.memberId) out.push({ kind: "member", result: r.member ?? { memberId: r.memberId ?? "", canSignIn: false } });
  if (r.staff || r.staffId) out.push({ kind: "user", result: r.staff ?? { userId: r.staffId ?? "" } });
  return out;
}

/** One sentence per moved record, full stop included, so several read as separate sentences. */
function describeMove(m: Moved): string {
  return m.kind === "member"
    ? `The member's contact address was changed${m.result.memberId ? ` (member ${m.result.memberId})` : ""}.`
    : `The staff account's login address was changed${m.result.userId ? ` (staff account ${m.result.userId})` : ""}.`;
}

/** The records a check says hold the address and that the review step can list with a move button. */
function movableHolders(c: CheckResult): SingleHolder[] {
  if (c.free || !c.holder) return [];
  return c.holder.kind === "many" ? c.holder.holders : [c.holder];
}

const STILL_HELD = "Checked again: the address is still held, so the owner's login address cannot change yet.";

const records = (n: number) => `${n} record${n === 1 ? "" : "s"}`;

const moveButtonLabel = (h: SingleHolder) =>
  h.kind === "member" ? "Change this member's contact address" : "Change this staff account's login address";

/**
 * A sign-in account with the owner role (a second owner row; nothing in the
 * database prevents one). The staff route refuses it and the check gives it no
 * version, so the panel offers no move for it, only this notice.
 */
const isOwnerHolder = (h: SingleHolder) => h.kind === "user" && h.status.toLowerCase() === "owner";
const OWNER_HOLDER_NOTICE =
  "Another owner account in this club uses this address. Owner accounts are not changed from here; contact MatFlow support.";

/** The "Held by" content for one holder: plain record kind, name, state, link, and a same-name note. */
function HolderDetails({ h, ownerName }: { h: SingleHolder; ownerName: string }) {
  const k = describeRecordKind(h.kind, h.status);
  const note = sameNameNote(h.name, ownerName);
  return (
    <>
      <span style={adminPill(h.kind === "member" ? "neutral" : "amber")}>{k.badge}</span> <span>{k.title}</span>: <strong>{h.name}</strong>{" "}
      {h.kind === "member" && (
        <>
          <span style={adminPill("neutral")}>{h.status}</span>{" "}
        </>
      )}
      <span style={adminPill(h.canSignIn ? "amber" : "neutral")}>
        {h.access === "password" ? "Can sign in" : h.access === "activation_pending" ? "Can activate (live invite or reset)" : "Cannot sign in"}
      </span>{" "}
      <a href={h.link} style={{ color: adminPalette.blue, fontSize: 12 }}>Open record</a>
      <span style={{ display: "block", fontSize: 11, color: adminPalette.muted }}>{k.detail}</span>
      <span style={{ display: "block", fontSize: 11, color: adminPalette.muted }}>id {h.id}</span>
      {note && <p role="note" style={noteStyle}>{note}</p>}
    </>
  );
}

type Props = {
  tenantId: string;
  ownerUserId: string;
  /** The address the owner should sign in with (as checked). */
  address: string;
  check: CheckResult;
  /** Step 1 already done (reload or "resume"): start with a fresh re-check. */
  resume?: ResumeState | null;
  onOwnerChanged: (email: string) => void;
  onClose: () => void;
};

const FRESH_CODE_HINT = "Your authenticator code works once. Wait for the next code before the second step.";

export default function ConflictPanel({ tenantId, ownerUserId, address, check, resume, onOwnerChanged, onClose }: Props) {
  const [current, setCurrent] = useState<CheckResult>(check);
  const holder = current.holder;
  // The records the operator can move from the review step: the one holder,
  // or every holder of a legacy duplicate.
  const targets: SingleHolder[] = !holder ? [] : holder.kind === "many" ? holder.holders : [holder];
  const single = holder && holder.kind !== "many" ? holder : null;
  // A resumed panel is opened with a FRESH check made by the card on load: it
  // starts at the owner step if the address is free now; if it is still held
  // by records that can be moved, it lists them (review), else it says why not.
  const resumedHeld = !!resume && !check.free && movableHolders(check).length > 0;
  const [phase, setPhase] = useState<Phase>(resume ? (check.free ? "owner_step" : resumedHeld ? "review" : "blocked") : "review");
  const [moved, setMoved] = useState<Moved[]>(() => movedFromResume(resume));
  const resumeRef = useRef<ResumeState>(resume ?? { address });
  const [step3, setStep3] = useState<OwnerStepResult | null>(null);
  const [verified, setVerified] = useState(false);
  const [verifyNote, setVerifyNote] = useState("");
  const [dialog, setDialog] = useState<"member" | "staff" | "owner" | null>(null);
  // The record the open member/staff dialog acts on.
  const [target, setTarget] = useState<SingleHolder | null>(single);
  const member = target?.kind === "member" ? target : null;
  const staff = target?.kind === "user" ? target : null;
  const [memberNewEmail, setMemberNewEmail] = useState("");
  const [staffNewEmail, setStaffNewEmail] = useState("");
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(resumedHeld ? STILL_HELD : null);

  /**
   * Re-check the owner's address (a read). Free → the owner step. Still held
   * by records that can be moved → back to the review step, which lists them
   * with their move buttons (also after "Check again" and on a resumed
   * duplicate). Otherwise (an error, or nothing movable) → blocked.
   */
  const recheck = useCallback(async () => {
    setPhase("rechecking");
    const r = await checkLoginAddress(tenantId, address);
    if (!r.ok) {
      setError(r.error);
      setPhase("blocked");
      return;
    }
    setCurrent(r.data);
    if (r.data.free) {
      setNotice(null);
      setPhase("owner_step");
      return;
    }
    if (movableHolders(r.data).length > 0) {
      setError(null);
      setNotice(STILL_HELD);
      setPhase("review");
      return;
    }
    setPhase("blocked");
  }, [tenantId, address]);

  function openDialog(which: "member" | "staff" | "owner", h?: SingleHolder) {
    setError(null);
    setCode("");
    setLost(null);
    if (h) {
      if (target && (target.kind !== h.kind || target.id !== h.id)) {
        setMemberNewEmail("");
        setStaffNewEmail("");
      }
      setTarget(h);
    }
    const ownerWhat = moved.every((m) => m.kind === "member")
      ? { change: "the conflicting member's contact address", see: "see the member change" }
      : moved.every((m) => m.kind === "user")
        ? { change: "the conflicting staff account's login address", see: "see the staff account change" }
        : { change: "the conflicting records' addresses", see: "see the earlier changes" };
    setReason(
      which !== "owner"
        ? `Owner login address conflict. Verified with the club: ${verifyNote.trim()}`
        : `Owner login address after moving ${ownerWhat.change}. Verified with the club: ${verifyNote.trim() || ownerWhat.see}`,
    );
    setDialog(which);
  }

  function recordMove(m: Moved, name: string) {
    setMoved((prev) => [...prev, m]);
    resumeRef.current =
      m.kind === "member"
        ? { ...resumeRef.current, address, memberId: m.result.memberId, memberName: name, member: m.result }
        : { ...resumeRef.current, address, staffId: m.result.userId, staffName: name, staff: m.result };
    saveResume(tenantId, resumeRef.current);
  }

  async function send(p: Pending): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string } | { ok: false; lost: true }> {
    let res: Response;
    try {
      res = await fetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [STEP_UP_HEADER]: p.grant },
        body: JSON.stringify(p.body),
      });
    } catch {
      return { ok: false, lost: true };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: String(data?.error ?? "The change was not made.") };
    return { ok: true, data };
  }

  async function submitMember() {
    if (busyRef.current || !member) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let p = lost?.kind === "member" ? lost : null;
      if (!p) {
        const newEmail = memberNewEmail.trim();
        const g = await requestGrant({ action: "member.contact_email", targetId: `${tenantId}/${member.id}/change`, change: { newEmail }, code });
        if (!g.ok) {
          setError(g.error);
          return;
        }
        p = {
          kind: "member",
          url: `/api/admin/customers/${tenantId}/members/${member.id}/contact-email`,
          grant: g.grant,
          body: { newEmail, reason: reason.trim(), version: member.version },
        };
      }
      const r = await send(p);
      if (!r.ok && "lost" in r) {
        setLost(p);
        setError("The response was lost, so it is not known whether the change was made. Re-send the same confirmation: it cannot be applied twice.");
        return;
      }
      setLost(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const result: MemberStepResult = {
        memberId: String(r.data.memberId ?? member.id),
        canSignIn: r.data.canSignIn === true,
        retired: r.data.retired as MemberStepResult["retired"],
        alreadyApplied: r.data.alreadyApplied === true,
      };
      recordMove({ kind: "member", result }, member.name);
      setDialog(null);
      await recheck();
    } finally {
      setCode("");
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitStaff() {
    if (busyRef.current || !staff) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let p = lost?.kind === "staff" ? lost : null;
      if (!p) {
        const newEmail = staffNewEmail.trim();
        const g = await requestGrant({ action: "staff.login_email", targetId: `${tenantId}/${staff.id}/change`, change: { newEmail }, code });
        if (!g.ok) {
          setError(g.error);
          return;
        }
        p = {
          kind: "staff",
          url: `/api/admin/customers/${tenantId}/staff/${staff.id}/login-email`,
          grant: g.grant,
          body: { newEmail, reason: reason.trim(), version: staff.version },
        };
      }
      const r = await send(p);
      if (!r.ok && "lost" in r) {
        setLost(p);
        setError("The response was lost, so it is not known whether the change was made. Re-send the same confirmation: it cannot be applied twice.");
        return;
      }
      setLost(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const result: StaffStepResult = {
        userId: String(r.data.userId ?? staff.id),
        retired: r.data.retired as StaffStepResult["retired"],
        alreadyApplied: r.data.alreadyApplied === true,
      };
      recordMove({ kind: "user", result }, staff.name);
      setDialog(null);
      await recheck();
    } finally {
      setCode("");
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitOwner() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let p = lost?.kind === "owner" ? lost : null;
      if (!p) {
        const g = await requestGrant({ action: "owner.login_email", targetId: `${tenantId}/${ownerUserId}/change`, change: { newEmail: address }, code });
        if (!g.ok) {
          setError(g.error);
          return;
        }
        p = {
          kind: "owner",
          url: `/api/admin/customers/${tenantId}/login-email`,
          grant: g.grant,
          body: { action: "change", reason: reason.trim(), newEmail: address },
        };
      }
      const r = await send(p);
      if (!r.ok && "lost" in r) {
        setLost(p);
        setError("The response was lost, so it is not known whether the change was made. Re-send the same confirmation: it cannot be applied twice.");
        return;
      }
      setLost(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setStep3({ ownerId: ownerUserId, provisional: r.data.provisional !== false, alreadyApplied: r.data.alreadyApplied === true });
      clearResume(tenantId);
      setDialog(null);
      setPhase("done");
      onOwnerChanged(address);
    } finally {
      setCode("");
      busyRef.current = false;
      setBusy(false);
    }
  }

  const codeOk = /^\d{6}$/.test(code);
  const reasonOk = reason.trim().length >= REASON_MIN && reason.trim().length <= 500;
  const memberEmailOk = /\S+@\S+\.\S+/.test(memberNewEmail.trim()) && memberNewEmail.trim().toLowerCase() !== address.trim().toLowerCase();
  const staffEmailOk = /\S+@\S+\.\S+/.test(staffNewEmail.trim()) && staffNewEmail.trim().toLowerCase() !== address.trim().toLowerCase();
  const canStartFor = (h: SingleHolder) => !!h.version && verified && verifyNote.trim().length >= REASON_MIN && !busy;
  const openMove = (h: SingleHolder) => openDialog(h.kind === "member" ? "member" : "staff", h);
  const partial = moved.length > 0 && step3 === null;
  // Duplicate progress while records still hold the address (ruling R10):
  // "Moved 1 of 2 records. 1 record still uses this address — move it below, …"
  const remaining = !holder ? 0 : holder.kind === "many" ? Math.max(holder.holders.length, holder.count) : 1;
  const listShown = phase === "review" && targets.length > 0;
  // Holders this panel can offer a move for (an owner-role holder never is).
  const anyMovable = targets.some((t) => !isOwnerHolder(t));
  const progress =
    partial && remaining > 0
      ? `Moved ${moved.length} of ${records(moved.length + remaining)}. ${records(remaining)} still ${remaining === 1 ? "uses" : "use"} this address${
          listShown ? ` — move ${remaining === 1 ? "it" : "them"} below, then change the owner's login address.` : "."
        }`
      : null;

  return (
    <section aria-label="Resolve login address conflict" style={panel}>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px" }}>Resolve conflict</h3>

      <dl style={grid}>
        <dt style={dt}>Club</dt>
        <dd style={dd}>{current.tenant.name}</dd>
        <dt style={dt}>Owner</dt>
        <dd style={dd}>{current.owner.name}</dd>
        <dt style={dt}>Address</dt>
        <dd style={dd}><code>{address}</code></dd>
        {single && (
          <>
            <dt style={dt}>Held by</dt>
            <dd style={dd}>
              <HolderDetails h={single} ownerName={current.owner.name} />
            </dd>
          </>
        )}
        {holder?.kind === "many" && (
          <>
            <dt style={dt}>Held by</dt>
            <dd style={dd}>{records(holder.count)} in this club{listShown ? " (listed below)" : ""}</dd>
          </>
        )}
      </dl>

      {holder?.kind === "many" && holder.holders.length === 0 && phase !== "done" && (
        <p role="alert" style={warn}>
          {holder.count} records in this club already hold this address (a legacy duplicate). Nothing can be resolved here: review the
          records with the club first.
        </p>
      )}

      {phase === "review" && targets.length > 0 && (
        <>
          {notice && <p role="status" style={{ ...warn, borderColor: adminPalette.amber }}>{notice}</p>}
          {progress && <p role="status" style={{ ...warn, borderColor: adminPalette.amber }}>{progress}</p>}
          {single && isOwnerHolder(single) && <p role="alert" style={warn}>{OWNER_HOLDER_NOTICE}</p>}
          {single?.kind === "user" && !isOwnerHolder(single) && (
            <p style={warn}>
              This staff account holds this address and signs in to the club&apos;s dashboard with it. Moving it signs {single.name} out
              everywhere; they then sign in with the new address.
            </p>
          )}
          {holder?.kind === "many" && (
            <p style={warn}>
              {holder.count} records in this club already hold this address (a legacy duplicate). Move each one to its own address
              below; the owner&apos;s login address can change once the address is free.
            </p>
          )}
          {anyMovable && (
            <>
              <p style={warn}>
                A matching name is not proof that these are the same person. Verify with the club by phone (call back on the number
                you already hold) before acting.
              </p>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, marginTop: 8 }}>
                <Checkbox checked={verified} onCheckedChange={setVerified} aria-label="I verified the relationship independently" />
                <span>
                  I verified independently, with the club, whose address this is and that{" "}
                  {single?.kind === "member"
                    ? `${single.name}'s contact address`
                    : single?.kind === "user"
                      ? `${single.name}'s login address`
                      : "each record's address"}{" "}
                  may change.
                </span>
              </label>
              <label htmlFor="conflict-verify-note" style={label}>How you verified it (recorded in the audit log, at least {REASON_MIN} characters)</label>
              <textarea
                id="conflict-verify-note"
                rows={2}
                value={verifyNote}
                onChange={(e) => setVerifyNote(e.target.value)}
                placeholder="e.g. call-back to the club's number on file; the owner confirmed Pat uses a personal address; ticket #123"
                style={{ ...field, resize: "vertical" }}
              />
            </>
          )}
          {single && !isOwnerHolder(single) && !single.version && (
            <p style={warn}>This record cannot be changed from here. Check the address again.</p>
          )}
          {holder?.kind === "many" && (
            <ul aria-label="Records holding this address" style={holderList}>
              {holder.holders.map((h) => (
                <li key={`${h.kind}:${h.id}`} style={holderItem}>
                  <span style={{ display: "block", fontSize: 12, color: adminPalette.muted, marginBottom: 2 }}>Held by</span>
                  <HolderDetails h={h} ownerName={current.owner.name} />
                  {isOwnerHolder(h) ? (
                    <p role="alert" style={warn}>{OWNER_HOLDER_NOTICE}</p>
                  ) : (
                    <>
                      {!h.version && <p style={warn}>This record cannot be changed from here. Check the address again.</p>}
                      <div style={actions}>
                        <Button variant="destructive" size="compact" onClick={() => openMove(h)} disabled={!canStartFor(h)}>
                          {moveButtonLabel(h)}
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div style={actions}>
            <Button variant="secondary" size="compact" onClick={onClose} disabled={busy}>Cancel</Button>
            {single && !isOwnerHolder(single) && (
              <Button variant="destructive" size="compact" onClick={() => openMove(single)} disabled={!canStartFor(single)}>
                {moveButtonLabel(single)}
              </Button>
            )}
          </div>
        </>
      )}

      {phase === "rechecking" && <p role="status" style={muted}>Checking the address again…</p>}

      {partial && !holder && phase !== "done" && (
        <p role="status" style={{ ...warn, borderColor: adminPalette.amber }}>
          Step 1 done, step 2 not done. {moved.map(describeMove).join(" ")} The owner&apos;s login address has not been changed yet.
          {phase === "owner_step" ? " Resume below." : ""}
        </p>
      )}

      {phase === "owner_step" && !holder && (
        <>
          <p role="status" style={{ ...muted, color: adminPalette.green }}>The address is now free in this club.</p>
          <p style={muted}>{FRESH_CODE_HINT}</p>
          <div style={actions}>
            <Button variant="secondary" size="compact" onClick={onClose} disabled={busy}>Close (resume later)</Button>
            <Button variant="destructive" size="compact" onClick={() => openDialog("owner")} disabled={busy}>
              Change the owner&apos;s login address
            </Button>
          </div>
        </>
      )}

      {phase === "blocked" && (
        <>
          <p role="alert" style={warn}>
            {current.free === false
              ? "The address is still held, so the owner's login address cannot be changed yet. Check the record and try again."
              : error ?? "The address could not be checked."}
          </p>
          {progress && <p role="status" style={muted}>{progress}</p>}
          <div style={actions}>
            <Button variant="secondary" size="compact" onClick={onClose} disabled={busy}>Close</Button>
            <Button variant="secondary" size="compact" onClick={() => void recheck()} disabled={busy}>Check again</Button>
          </div>
        </>
      )}

      {phase === "done" && (
        <div role="status" style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px", color: adminPalette.green }}>Conflict resolved</p>
          <ol style={{ fontSize: 13, margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            {moved.map((m, i) =>
              m.kind === "member" ? (
                <li key={i}>
                  Member contact address changed{m.result.alreadyApplied ? " (already applied)" : ""} — member {m.result.memberId}.{" "}
                  {m.result.canSignIn
                    ? "They were signed out everywhere and sign in with the new address."
                    : "They had no password: outstanding invite, sign-in and reset links were retired."}
                </li>
              ) : (
                <li key={i}>
                  Staff account login address changed{m.result.alreadyApplied ? " (already applied)" : ""} — staff account {m.result.userId}.
                  They were signed out everywhere and sign in with the new address, which is provisional (unverified).
                </li>
              ),
            )}
            <li>Address re-checked — free in this club.</li>
            <li>
              Owner login address changed{step3?.alreadyApplied ? " (already applied)" : ""} — owner {step3?.ownerId}. It is provisional
              (unverified); the owner was signed out everywhere.
            </li>
          </ol>
          <div style={actions}>
            <Button variant="secondary" size="compact" onClick={onClose}>Close</Button>
          </div>
        </div>
      )}

      {error && dialog === null && phase !== "blocked" && <p role="alert" style={errorText}>{error}</p>}

      <Dialog
        open={dialog === "member"}
        onClose={() => { if (!busy) setDialog(null); }}
        title="Change this member's contact address"
        description={member ? `${member.name} in ${current.tenant.name}. Only the address changes: their membership, import identity, password and history stay as they are.` : undefined}
        footer={
          <div style={actions}>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={submitMember}
              loading={busy}
              disabled={busy || (lost?.kind !== "member" && !(memberEmailOk && reasonOk && codeOk))}
            >
              {lost?.kind === "member" ? "Re-send the same confirmation" : "Change contact address"}
            </Button>
          </div>
        }
      >
        <label htmlFor="conflict-member-email" style={label}>The member&apos;s new contact address</label>
        <input id="conflict-member-email" type="email" autoComplete="off" value={memberNewEmail} disabled={busy || !!lost} onChange={(e) => setMemberNewEmail(e.target.value)} style={field} />
        <p style={hint}>
          {member?.canSignIn
            ? "This member can sign in: they will be signed out everywhere and the new address is unverified."
            : "This member has no password: any outstanding invite, sign-in or reset link is retired."}
        </p>
        <label htmlFor="conflict-member-reason" style={label}>Reason (audit-logged, at least {REASON_MIN} characters)</label>
        <textarea id="conflict-member-reason" rows={3} value={reason} disabled={busy || !!lost} onChange={(e) => setReason(e.target.value)} style={{ ...field, resize: "vertical" }} />
        {!lost && (
          <>
            <label htmlFor="conflict-member-code" style={label}>Your authenticator code (confirms it is you)</label>
            <input id="conflict-member-code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={code} disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={codeField} />
          </>
        )}
        {error && <p role="alert" style={errorText}>{error}</p>}
      </Dialog>

      <Dialog
        open={dialog === "staff"}
        onClose={() => { if (!busy) setDialog(null); }}
        title="Change this staff account's login address"
        description={staff ? `${staff.name} will be signed out everywhere and must sign in with the new address.` : undefined}
        footer={
          <div style={actions}>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={submitStaff}
              loading={busy}
              disabled={busy || (lost?.kind !== "staff" && !(staffEmailOk && reasonOk && codeOk))}
            >
              {lost?.kind === "staff" ? "Re-send the same confirmation" : "Change login address"}
            </Button>
          </div>
        }
      >
        <label htmlFor="conflict-staff-email" style={label}>The staff account&apos;s new login address</label>
        <input id="conflict-staff-email" type="email" autoComplete="off" value={staffNewEmail} disabled={busy || !!lost} onChange={(e) => setStaffNewEmail(e.target.value)} style={field} />
        <p style={hint}>
          {staff ? `${staff.name} in ${current.tenant.name}. ` : ""}Only the login address changes: their role, password and authenticator stay
          as they are. The new address is provisional (unverified), and any outstanding invite, sign-in or reset link is retired.
          While it is unverified, password-reset codes, emailed sign-in links and Google sign-in do not work for them; if they forget
          their password, the club owner sets a temporary one in Staff settings.
        </p>
        <label htmlFor="conflict-staff-reason" style={label}>Reason (audit-logged, at least {REASON_MIN} characters)</label>
        <textarea id="conflict-staff-reason" rows={3} value={reason} disabled={busy || !!lost} onChange={(e) => setReason(e.target.value)} style={{ ...field, resize: "vertical" }} />
        {!lost && (
          <>
            <label htmlFor="conflict-staff-code" style={label}>Your authenticator code (confirms it is you)</label>
            <input id="conflict-staff-code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={code} disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={codeField} />
          </>
        )}
        {error && <p role="alert" style={errorText}>{error}</p>}
      </Dialog>

      <Dialog
        open={dialog === "owner"}
        onClose={() => { if (!busy) setDialog(null); }}
        title="Change the owner's login address"
        description={`${current.owner.name} will sign in with ${address}. Same account, role, password and authenticator; signed out everywhere; the address is provisional.`}
        footer={
          <div style={actions}>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={submitOwner} loading={busy} disabled={busy || (lost?.kind !== "owner" && !(reasonOk && codeOk))}>
              {lost?.kind === "owner" ? "Re-send the same confirmation" : "Change login address"}
            </Button>
          </div>
        }
      >
        <p style={hint}>{FRESH_CODE_HINT}</p>
        <label htmlFor="conflict-owner-reason" style={label}>Reason (audit-logged, at least {REASON_MIN} characters)</label>
        <textarea id="conflict-owner-reason" rows={3} value={reason} disabled={busy || !!lost} onChange={(e) => setReason(e.target.value)} style={{ ...field, resize: "vertical" }} />
        {!lost && (
          <>
            <label htmlFor="conflict-owner-code" style={label}>A new authenticator code</label>
            <input id="conflict-owner-code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" value={code} disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={codeField} />
          </>
        )}
        {error && <p role="alert" style={errorText}>{error}</p>}
      </Dialog>
    </section>
  );
}

const panel: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  borderRadius: 12,
  border: `1px solid ${adminPalette.amber}`,
  background: adminPalette.amberSoft,
};
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: "0 0 8px", fontSize: 13 };
const dt: React.CSSProperties = { color: adminPalette.muted };
const dd: React.CSSProperties = { margin: 0 };
const muted: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, margin: "8px 0 0" };
const warn: React.CSSProperties = {
  fontSize: 12,
  color: adminPalette.body,
  background: adminPalette.card,
  border: `1px solid ${adminPalette.borderStrong}`,
  borderRadius: 8,
  padding: 10,
  margin: "8px 0 0",
  lineHeight: 1.5,
};
const errorText: React.CSSProperties = { color: adminPalette.red, fontSize: 12, margin: "8px 0 0" };
const actions: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flexWrap: "wrap" };
const label: React.CSSProperties = { fontSize: 12, opacity: 0.7, display: "block", marginTop: 12, marginBottom: 4 };
const hint: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, margin: "6px 0 0" };
const field: React.CSSProperties = {
  width: "100%",
  background: adminPalette.card,
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  padding: 10,
  color: adminPalette.text,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
const codeField: React.CSSProperties = { ...field, fontFamily: "monospace", letterSpacing: 4, textAlign: "center" };
const noteStyle: React.CSSProperties = { fontSize: 12, color: adminPalette.body, margin: "6px 0 0", lineHeight: 1.5 };
const holderList: React.CSSProperties = { listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 };
const holderItem: React.CSSProperties = {
  fontSize: 13,
  background: adminPalette.card,
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  padding: 10,
};
