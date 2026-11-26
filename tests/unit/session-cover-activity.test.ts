// Session cover (26 Nov 2026) in the Activity timeline: every cover action has a sentence built only from the ids
// on its audit row (the session, the coach, the coach it replaced), its own type, and a label.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUDIT_LABELS } from "@/lib/audit-labels";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { emptyLookups, toFeedEntry, type ActivityLookups, type FeedContext, type FeedRow } from "@/lib/activity-feed";

const OWNER = { id: "u_olive", name: "Olive Owner" };
const SAM = { id: "u_sam", name: "Sam Cover" };

function lookups(): ActivityLookups {
  const L = emptyLookups();
  L.classes.set("c_adults", { name: "Adults Gi" });
  L.sessions.set("s_thu", { classId: "c_adults", className: "Adults Gi", date: new Date("2026-12-03T00:00:00Z"), startTime: "19:00" });
  L.staff.set(OWNER.id, { name: OWNER.name });
  L.staff.set(SAM.id, { name: SAM.name });
  L.staff.set("u_kim", { name: "Kim Coach" });
  return L;
}
let seq = 0;
const row = (over: Partial<FeedRow> & Pick<FeedRow, "action">): FeedRow => ({
  id: `a${++seq}`, entityType: "ClassInstance", entityId: "s_thu", metadata: null, createdAt: new Date("2026-11-26T10:00:00Z"), userId: null, operatorId: null, user: null, ...over,
});
const ctx: FeedContext = { lookups: lookups(), role: "owner", timeZone: "Europe/London" };
const meta = { classId: "c_adults", date: "2026-12-03T00:00:00.000Z", startTime: "19:00", endTime: "20:30" };
const by = (u: { id: string; name: string }) => ({ userId: u.id, user: u });
const plain = (r: FeedRow) => toFeedEntry(r, ctx).plain;

const COVER_ACTIONS = Object.keys(AUDIT_LABELS).filter((a) => a.startsWith("class.cover_"));

describe("session cover in Activity", () => {
  it("every cover action has a label and belongs to the Class cover type, which owners and managers see", () => {
    expect(COVER_ACTIONS.sort()).toEqual([
      "class.cover_assigned", "class.cover_claimed", "class.cover_closed", "class.cover_given_up", "class.cover_moved", "class.cover_reconfirm_flagged",
      "class.cover_reconfirmed", "class.cover_replaced", "class.cover_requested", "class.cover_returned_to_regular", "class.cover_withdrawn",
    ]);
    const type = ACTIVITY_TYPES.find((t) => t.key === "session_cover")!;
    expect(type.actions.sort()).toEqual(COVER_ACTIONS.sort());
    expect(type.roles).toEqual(["owner", "manager"]);
    expect(type.defaultOn).toBe(true);
  });

  it("who requested and who accepted", () => {
    expect(plain(row({ action: "class.cover_requested", ...by(OWNER), metadata: meta }))).toBe("Olive Owner asked for cover for Adults Gi · Thu 3 Dec, 19:00");
    expect(plain(row({ action: "class.cover_claimed", ...by(SAM), metadata: { ...meta, coverUserId: SAM.id } }))).toBe("Sam Cover is covering Adults Gi · Thu 3 Dec, 19:00");
    expect(toFeedEntry(row({ action: "class.cover_claimed", ...by(SAM), metadata: { ...meta, coverUserId: SAM.id } }), ctx).type).toBe("session_cover");
  });

  it("assigned, replaced, given up, withdrawn, returned, reconfirmed", () => {
    expect(plain(row({ action: "class.cover_assigned", ...by(OWNER), metadata: { ...meta, coverUserId: SAM.id } }))).toBe("Olive Owner assigned Sam Cover to cover Adults Gi · Thu 3 Dec, 19:00");
    expect(plain(row({ action: "class.cover_replaced", ...by(OWNER), metadata: { ...meta, coverUserId: "u_kim", previousCoverUserId: SAM.id } }))).toBe("Olive Owner replaced Sam Cover with Kim Coach to cover Adults Gi · Thu 3 Dec, 19:00");
    expect(plain(row({ action: "class.cover_given_up", ...by(SAM), metadata: { ...meta, previousCoverUserId: SAM.id } }))).toBe("Sam Cover gave up covering Adults Gi · Thu 3 Dec, 19:00, which needs cover again");
    expect(plain(row({ action: "class.cover_given_up", ...by(OWNER), metadata: { ...meta, previousCoverUserId: SAM.id } }))).toBe("Olive Owner took Sam Cover off Adults Gi · Thu 3 Dec, 19:00, which needs cover again");
    expect(plain(row({ action: "class.cover_withdrawn", ...by(OWNER), metadata: meta }))).toBe("Olive Owner withdrew the cover request for Adults Gi · Thu 3 Dec, 19:00");
    expect(plain(row({ action: "class.cover_returned_to_regular", ...by(OWNER), metadata: { ...meta, previousCoverUserId: SAM.id } }))).toBe("Olive Owner returned Adults Gi · Thu 3 Dec, 19:00 to its regular coach");
    expect(plain(row({ action: "class.cover_reconfirmed", ...by(SAM), metadata: { ...meta, coverUserId: SAM.id } }))).toBe("Sam Cover reconfirmed covering Adults Gi · Thu 3 Dec, 19:00");
  });

  it("closed by a cancel or a removed session, and flagged for reconfirmation — the session named even once it is gone", () => {
    expect(plain(row({ action: "class.cover_closed", ...by(OWNER), metadata: { ...meta, closedReason: "session_cancelled" } }))).toBe("The cover request for Adults Gi · Thu 3 Dec, 19:00 closed: the session was cancelled");
    expect(plain(row({ action: "class.cover_closed", entityId: "s_gone", ...by(OWNER), metadata: { ...meta, closedReason: "session_removed" } }))).toBe(
      "The cover request for Adults Gi · Thu 3 Dec, 19:00 closed: the class's weekly time changed and the session was removed",
    );
    expect(plain(row({ action: "class.cover_closed", entityId: "s_gone", ...by(OWNER), metadata: { ...meta, closedReason: "replacement_ambiguous" } }))).toBe(
      "The cover request for Adults Gi · Thu 3 Dec, 19:00 closed: the class's weekly times changed and its new session is not clear; request cover on the intended session",
    );
    expect(plain(row({ action: "class.cover_reconfirm_flagged", ...by(OWNER), metadata: { ...meta, coverUserId: SAM.id, previousStartTime: "18:30" } }))).toBe(
      "Adults Gi · Thu 3 Dec, 19:00 changed time after Sam Cover took the cover; they need to reconfirm",
    );
  });

  it("round 2: archive, pause, a started replacement, a moved open request and a deactivated coach each say what happened", () => {
    const closed = (closedReason: string) => plain(row({ action: "class.cover_closed", ...by(OWNER), metadata: { ...meta, closedReason } }));
    expect(closed("class_archived")).toBe("The cover request for Adults Gi · Thu 3 Dec, 19:00 closed: the class was archived");
    expect(closed("class_paused")).toBe("The cover request for Adults Gi · Thu 3 Dec, 19:00 closed: the class was paused");
    expect(closed("replacement_started")).toBe("The cover request for Adults Gi · Thu 3 Dec, 19:00 closed: the class's new time that day had already started; request cover on the intended session");
    expect(plain(row({ action: "class.cover_moved", ...by(OWNER), metadata: { ...meta, previousStartTime: "18:30" } }))).toBe("The cover request moved with the class's new time to Adults Gi · Thu 3 Dec, 19:00 (it was at 18:30)");
    expect(plain(row({ action: "class.cover_given_up", ...by(OWNER), metadata: { ...meta, previousCoverUserId: SAM.id, reason: "coach_deactivated" } }))).toBe("Olive Owner deactivated Sam Cover, so Adults Gi · Thu 3 Dec, 19:00 needs cover again");
  });

  it("a cover row on a session that has since been deleted still names it from its own metadata", () => {
    expect(plain(row({ action: "class.cover_claimed", entityId: "s_deleted", ...by(SAM), metadata: { ...meta, coverUserId: SAM.id } }))).toBe("Sam Cover is covering Adults Gi · Thu 3 Dec, 19:00");
  });

  it("cover_closed, cover_reconfirm_flagged and cover_moved are staff actions: a row with no staff member is a removed account, not automatic", () => {
    for (const action of ["class.cover_closed", "class.cover_reconfirm_flagged", "class.cover_moved"]) {
      const e = toFeedEntry(row({ action, metadata: { ...meta, closedReason: "session_cancelled", previousStartTime: "18:30", coverUserId: SAM.id } }), ctx);
      expect(e.source?.label, action).not.toBe("Automatic");
    }
  });
});
