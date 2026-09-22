"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  initialCreditType,
  type SignupCreditType,
} from "@/lib/signup-credit";

// Attribution (M1) capture — the shared "who ran the trial / who gets the
// sign-up credit" controls, used by the member ADD form (MembersList's
// AddMemberModal) and the member EDIT form (MemberProfile). The schema + API
// already accept the four fields; this is the capture surface only.
//
// The credit control is a single type selector (Staff / Member / Other) that
// reveals the matching input, so the mutual exclusion the DB enforces is
// expressed in the UI: only one target can ever be entered at a time. The
// pure resolver in lib/signup-credit.ts is what the host form calls to turn
// this state into the exactly-one-or-none body it POSTs.

export interface AttributionValue {
  /** "" = none */
  trialRunById: string;
  creditType: SignupCreditType;
  /** "" = none */
  creditedToUserId: string;
  /** "" = none */
  creditedToMemberId: string;
  creditedToLabel: string;
}

export const emptyAttribution: AttributionValue = {
  trialRunById: "",
  creditType: "none",
  creditedToUserId: "",
  creditedToMemberId: "",
  creditedToLabel: "",
};

/** Seed the form state from a member's stored attribution values (edit form). */
export function attributionFromMember(m: {
  trialRunById?: string | null;
  creditedToUserId?: string | null;
  creditedToMemberId?: string | null;
  creditedToLabel?: string | null;
}): AttributionValue {
  return {
    trialRunById: m.trialRunById ?? "",
    creditType: initialCreditType(m),
    creditedToUserId: m.creditedToUserId ?? "",
    creditedToMemberId: m.creditedToMemberId ?? "",
    creditedToLabel: m.creditedToLabel ?? "",
  };
}

type StaffOption = { id: string; name: string; role: string };
type MemberOption = { id: string; name: string };

interface Props {
  value: AttributionValue;
  onChange: (v: AttributionValue) => void;
  /** Host-supplied styling so the controls match their form (add vs edit). */
  inputClassName: string;
  inputStyle: React.CSSProperties;
  focusHandlers: {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => void;
  };
  /** Exclude this member from the "brought a friend" search (edit form). */
  selfMemberId?: string;
  /** Name for a pre-selected friend so the option renders without a lookup. */
  initialCreditedMemberName?: string | null;
}

const labelCls = "block text-xs font-medium mb-1.5";
const labelStyle = { color: "var(--tx-3)" } as const;

export default function AttributionFields({
  value,
  onChange,
  inputClassName,
  inputStyle,
  focusHandlers,
  selfMemberId,
  initialCreditedMemberName,
}: Props) {
  // ── Staff list (trial-run picker + staff-credit picker) ──────────────────
  // The retry bumps a reload key rather than calling a fetch the effect also
  // depends on: setState belongs in the async then/catch, never synchronously
  // in the effect body (react-hooks/set-state-in-effect). Same shape as
  // MemberProfile's DetailsHistory.
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  const [staffError, setStaffError] = useState(false);
  const [staffReload, setStaffReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/staff/assignable")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((rows: StaffOption[]) => {
        if (!cancelled) setStaff(Array.isArray(rows) ? rows : []);
      })
      // A failed lookup is an error, never an empty staff list (UI-RULES §7):
      // the two say opposite things about whether this gym has any coaches.
      .catch(() => {
        if (!cancelled) setStaffError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [staffReload]);

  // Event handler, not effect body — synchronous setState here is fine.
  const retryStaff = useCallback(() => {
    setStaff(null);
    setStaffError(false);
    setStaffReload((k) => k + 1);
  }, []);

  // ── Friend search ("brought a friend") ───────────────────────────────────
  const [friendQuery, setFriendQuery] = useState("");
  const [friendResults, setFriendResults] = useState<MemberOption[]>([]);
  const [friendSearching, setFriendSearching] = useState(false);
  const friendReqRef = useRef(0);

  // All setState lives inside the debounced timeout / promise callbacks, never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (value.creditType !== "member") return;
    const q = friendQuery.trim();
    const seq = ++friendReqRef.current;
    const t = setTimeout(() => {
      if (q.length < 2) {
        setFriendResults([]);
        setFriendSearching(false);
        return;
      }
      setFriendSearching(true);
      fetch(`/api/members?search=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: { members?: MemberOption[] }) => {
          if (seq !== friendReqRef.current) return; // a newer keystroke won
          const rows = (data.members ?? []).filter((m) => m.id !== selfMemberId);
          setFriendResults(rows);
        })
        .catch(() => {
          if (seq === friendReqRef.current) setFriendResults([]);
        })
        .finally(() => {
          if (seq === friendReqRef.current) setFriendSearching(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [friendQuery, value.creditType, selfMemberId]);

  const set = (patch: Partial<AttributionValue>) => onChange({ ...value, ...patch });

  // The friend picker always offers the currently-chosen member, even before
  // a search runs (edit form re-open), by seeding an option from the id + name.
  const friendOptions: MemberOption[] = (() => {
    const opts = [...friendResults];
    if (value.creditedToMemberId && !opts.some((o) => o.id === value.creditedToMemberId)) {
      opts.unshift({
        id: value.creditedToMemberId,
        name: initialCreditedMemberName ?? "Selected member",
      });
    }
    return opts;
  })();

  return (
    <div className="space-y-3">
      {/* Trial run by — a staff picker */}
      <div>
        <label className={labelCls} style={labelStyle}>
          Trial run by
        </label>
        {staffError ? (
          <ErrorState message="Couldn't load staff" onRetry={retryStaff} />
        ) : staff === null ? (
          <Skeleton className="h-[42px] w-full" />
        ) : (
          <select
            aria-label="Trial run by"
            value={value.trialRunById}
            onChange={(e) => set({ trialRunById: e.target.value })}
            className={inputClassName + " appearance-none"}
            style={inputStyle}
            {...focusHandlers}
          >
            <option value="">Not recorded</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.role}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Signed up by — one of staff / member / other, mutually exclusive */}
      <div>
        <label className={labelCls} style={labelStyle}>
          Signed up by (credit)
        </label>
        <select
          aria-label="Sign-up credit type"
          value={value.creditType}
          onChange={(e) =>
            // Switching type clears the other targets so nothing stale is kept
            // — the resolver would drop them anyway, but a clean state also
            // keeps the revealed input empty rather than showing a ghost value.
            set({
              creditType: e.target.value as SignupCreditType,
              creditedToUserId: "",
              creditedToMemberId: "",
              creditedToLabel: "",
            })
          }
          className={inputClassName + " appearance-none"}
          style={inputStyle}
          {...focusHandlers}
        >
          <option value="none">Not recorded</option>
          <option value="staff">A staff member</option>
          <option value="member">Brought by a member</option>
          <option value="other">Other source</option>
        </select>

        {value.creditType === "staff" && (
          <div className="mt-2">
            {staffError ? (
              <ErrorState message="Couldn't load staff" onRetry={retryStaff} />
            ) : staff === null ? (
              <Skeleton className="h-[42px] w-full" />
            ) : (
              <select
                aria-label="Credited staff member"
                value={value.creditedToUserId}
                onChange={(e) => set({ creditedToUserId: e.target.value })}
                className={inputClassName + " appearance-none"}
                style={inputStyle}
                {...focusHandlers}
              >
                <option value="">Select staff…</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.role}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {value.creditType === "member" && (
          <div className="mt-2 space-y-2">
            <input
              aria-label="Search members"
              type="search"
              value={friendQuery}
              onChange={(e) => setFriendQuery(e.target.value)}
              placeholder="Search by name or email"
              className={inputClassName}
              style={inputStyle}
              {...focusHandlers}
            />
            <select
              aria-label="Credited member"
              value={value.creditedToMemberId}
              onChange={(e) => set({ creditedToMemberId: e.target.value })}
              className={inputClassName + " appearance-none"}
              style={inputStyle}
              {...focusHandlers}
            >
              <option value="">
                {friendSearching
                  ? "Searching…"
                  : friendOptions.length === 0
                    ? "Type a name to search"
                    : "Select member…"}
              </option>
              {friendOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {value.creditType === "other" && (
          <div className="mt-2">
            <input
              aria-label="Sign-up source"
              type="text"
              value={value.creditedToLabel}
              onChange={(e) => set({ creditedToLabel: e.target.value })}
              placeholder="e.g. Instagram ad, walk-in"
              maxLength={120}
              className={inputClassName}
              style={inputStyle}
              {...focusHandlers}
            />
          </div>
        )}
      </div>
    </div>
  );
}
