/**
 * Human sentences for AuditLog.action — the owner's Activity page (1 Oct 2026,
 * "somewhere owners can view all behaviours and actions that an admin has
 * done"). One entry per action name the product writes; an unknown name is
 * humanised ("member.photo.add" → "Member photo add") rather than left raw or
 * blank, so a new action can never make a row unreadable. A unit test scans
 * app/ and lib/ for every literal action name and fails on any missing here.
 *
 * Sentences are in the past tense, British English, and name the thing not
 * the table: "Updated a member's details", not "member.update".
 */

export const AUDIT_LABELS: Record<string, string> = {
  // ── Members ───────────────────────────────────────────────────────────────
  "member.create": "Added a member",
  "member.update": "Updated a member's details",
  "member.self_update": "Member updated their own details",
  "member.delete": "Deleted a member",
  "member.create.kid": "Added a child",
  "member.child.update": "Parent updated a child's details",
  "member.child.delete": "Parent removed a child",
  "member.link.child": "Linked a child to a parent",
  "member.unlink.child": "Unlinked a child from a parent",
  "member.promoted_to_adult": "Promoted a child to an adult account",
  "member.attribution.update": "Changed who gets credit for a member",
  "member.hold.start": "Put a membership on hold",
  "member.hold.end": "Resumed a membership",
  "member.rank.promote": "Promoted a member's rank",
  "member.rank.demote": "Demoted a member's rank",
  "member.photo.add": "Added a member photo",
  "member.photo.create": "Added a member photo",
  "member.photo.remove": "Removed a member photo",
  "member.photo.delete": "Removed a member photo",
  "member.profile_picture.set": "Set a member's profile picture",
  "member.profile_picture.upload": "Uploaded a member's profile picture",
  "upload.image": "Uploaded an image",
  "member.profile_picture.clear": "Cleared a member's profile picture",
  "member.card_revoked": "Revoked a member's card",
  "member.unlock": "Unlocked a member's sign-in",
  "member.totp_reset": "Reset a member's authenticator",
  "member.invite_link.generated": "Generated a member invite link",
  "member.waiver_link.generated": "Generated a waiver link",
  "member.waiver.signed_via_kiosk": "Member signed the waiver at the kiosk",
  "member.bulk_invite": "Sent login invites to members",
  "member.dsar_export": "Exported a member's data (subject access)",
  "member.dsar_erase": "Erased a member's data (right to erasure)",
  "member.payment.failed": "A member's payment failed",
  "member.payment.succeeded": "A member's payment succeeded",
  "member.subscription.cancel": "Member cancelled their subscription",
  "member.subscription.cancel.kid": "Parent cancelled a child's subscription",
  "member.subscription.cancelled_by_stripe": "Subscription ended by Stripe",
  "member.subscription.create.kid": "Parent started a child's subscription",
  "member.subscription.migrated": "Moved a membership onto MatFlow billing",
  "member.subscription.portal.kid": "Parent opened a child's billing portal",

  // ── Waivers ───────────────────────────────────────────────────────────────
  "waiver.sign": "Signed the waiver",
  "waiver.sign.supervised": "Signed the waiver at the desk (supervised)",
  "waiver.signature.view": "Viewed a signed waiver",

  // ── Attendance ────────────────────────────────────────────────────────────
  "attendance.mark": "Checked a member in",
  "attendance.override": "Removed a check-in from the register",
  "attendance.self_checkin": "Member checked themselves in",
  "attendance.kiosk_checkin": "Member checked in at the kiosk",
  "attendance.card_scan": "Member checked in by card",
  "attendance.undo": "Undid a check-in",
  "attendance.unmark": "Removed a check-in from the register",

  // ── Classes & timetable ───────────────────────────────────────────────────
  "class.created": "Created a class",
  "class.updated": "Updated a class",
  "class.deleted": "Deleted a class",
  "class.instances_generated": "Generated timetable sessions",
  "class.instance_cancelled": "Cancelled a session",
  "class.instance_restored": "Restored a cancelled session",
  "class.roster.add": "Added a member to a class roster",
  "class.roster.remove": "Removed a member from a class roster",
  "location.create": "Added a venue",
  "location.update": "Updated a venue",
  "location.delete": "Removed a venue",

  // ── Memberships, packs, ranks ─────────────────────────────────────────────
  "membership.tier.create": "Created a membership plan",
  "membership.tier.update": "Updated a membership plan",
  "membership.tier.delete": "Deleted a membership plan",
  "membership.tier.price_created": "Created a Stripe price for a plan",
  "class_pack.create": "Created a class pack",
  "class_pack.update": "Updated a class pack",
  "class_pack.deactivate": "Deactivated a class pack",
  "rank.created": "Created a rank",
  "rank.updated": "Updated a rank",
  "rank.deleted": "Deleted a rank",
  "rank.photo_attached": "Attached a photo to a rank change",

  // ── Money ─────────────────────────────────────────────────────────────────
  "payment.manual": "Recorded a payment at the desk",
  "payment.adhoc.charge": "Charged a member's card",
  "payment.refund": "Refunded a payment",
  "payment.chase": "Sent a payment reminder",
  "payments.export": "Exported payments to CSV",
  "order.mark_paid": "Marked a shop order as paid",
  "billing.portal.open": "Opened the billing portal",
  "stripe.connect": "Connected Stripe",
  "stripe.disconnect": "Disconnected Stripe",
  "stripe.account.deauthorized": "Stripe access was revoked",
  "stripe.checkout.expired": "A checkout expired unpaid",
  "stripe.payment_intent.failed": "A card payment failed",
  "stripe.payment_method.detached": "A saved card was removed",
  "stripe.webhook.account_updated": "Stripe account status changed",

  // ── Communications & tasks ────────────────────────────────────────────────
  "announcement.created": "Posted an announcement",
  "announcement.updated": "Edited an announcement",
  "announcement.deleted": "Deleted an announcement",
  "task.staff_task.create": "Created a staff task",
  "task.member_note.create": "Left a note for a member",
  "task.member_note.complete": "Member completed a note",
  "task.complete": "Completed a task",
  "initiative.create": "Created an initiative",
  "initiative.update": "Updated an initiative",
  "initiative.delete": "Deleted an initiative",
  "initiative.attachment.add": "Attached a file to an initiative",
  "initiative.attachment.remove": "Removed a file from an initiative",
  "email.test_sent": "Sent a test email",
  "report.generate": "Generated a report",

  // ── Staff & settings ──────────────────────────────────────────────────────
  "staff.invite": "Invited a staff member",
  "staff.update": "Updated a staff member",
  "staff.delete": "Removed a staff member",
  "staff.unlock": "Unlocked a staff sign-in",
  "staff.totp_reset": "Reset a staff member's authenticator",
  "staff.ownership_transferred": "Transferred club ownership",
  "tenant.settings.update": "Changed club settings",
  "tenant.kiosk.enabled": "Enabled the kiosk",
  "tenant.kiosk.disabled": "Disabled the kiosk",
  "tenant.kiosk.regenerated": "Rotated the kiosk link",
  "tenant.display.enabled": "Enabled the leaderboard display",
  "tenant.display.disabled": "Disabled the leaderboard display",
  "tenant.display.regenerated": "Rotated the leaderboard link",
  "tenant.onboarding.reset": "Restarted the setup wizard",
  "onboarding.csv_handoff": "Sent a member list for assisted import",
  "drive.connect": "Connected Google Drive",
  "drive.disconnect": "Disconnected Google Drive",
  "drive.folder.select": "Chose a Google Drive folder",
  "drive.index": "Indexed Google Drive documents",

  // ── Imports ───────────────────────────────────────────────────────────────
  "import.upload": "Uploaded a member list",
  "import.commit": "Imported members",
  "import.refresh": "Refreshed member statuses from an import",
  "import.rollback": "Rolled back an import",
  "import.attendance.preview": "Previewed an attendance import",
  "import.attendance.commit": "Imported attendance history",
  "import.attendance.rollback": "Rolled back an attendance import",

  // ── Sign-in & security ────────────────────────────────────────────────────
  "auth.magic_link.request": "Requested a sign-in link",
  "auth.magic_link.consume": "Signed in with a link",
  "auth.logout_all": "Signed out of every device",
  "auth.login.disowned": "Reported a sign-in as not theirs",
  "auth.login.new_device_notified": "New-device sign-in alert sent",
  "auth.totp.recovery_codes.generated": "Generated authenticator recovery codes",
  "auth.totp.recovery.used": "Signed in with a recovery code",
  "auth.totp.recovery.failed": "Recovery code refused",
  "auth.member.totp.recovery_codes.generated": "Member generated recovery codes",
  "auth.member.totp.recovery.used": "Member signed in with a recovery code",
  "auth.member.totp.recovery.failed": "Member recovery code refused",
  "user.password.set_own": "Set their own password",

  // ── Operator (MatFlow) ────────────────────────────────────────────────────
  "admin.application.approve": "MatFlow approved the club application",
  "admin.application.reject": "MatFlow rejected a club application",
  "admin.tenant.create": "MatFlow created the club",
  "admin.tenant.suspended": "MatFlow suspended the club",
  "admin.tenant.reactivated": "MatFlow reactivated the club",
  "admin.tenant.soft_deleted": "MatFlow closed the club",
  "admin.tenant.restored": "MatFlow restored the club",
  "admin.tenant.hard_deleted": "MatFlow permanently deleted a club",
  "admin.tenant.review_locked": "MatFlow put the club in review mode",
  "admin.tenant.review_unlocked": "MatFlow took the club out of review mode",
  "admin.tenant.ownership_transferred": "MatFlow transferred club ownership",
  "admin.owner.force_password_reset": "MatFlow issued the owner a temporary password",
  "admin.owner.totp_reset": "MatFlow reset the owner's authenticator",
  "admin.member.totp_reset": "MatFlow reset a member's authenticator",
  "admin.impersonate.start": "MatFlow support signed in as the owner",
  "admin.impersonate.end": "MatFlow support ended the support session",
};

/** "member.photo.add" → "Member photo add" — only for names not in the map. */
export function humaniseAction(action: string): string {
  const words = action.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditLabel(action: string): string {
  if (action in AUDIT_LABELS) return AUDIT_LABELS[action];
  // Dynamic names: the webhook writes `stripe.dispute.<status>`.
  if (action.startsWith("stripe.dispute.")) return `Dispute ${action.slice("stripe.dispute.".length).replace(/_/g, " ")}`;
  return humaniseAction(action);
}

/** Undo rows are written as `undo.<original action>`. */
export const UNDO_PREFIX = "undo.";

export function isUndoAction(action: string): boolean {
  return action.startsWith(UNDO_PREFIX);
}

/** "undo.member.update" → "Undid: Updated a member's details". */
export function auditLabelWithUndo(action: string): string {
  if (isUndoAction(action)) return `Undid: ${auditLabel(action.slice(UNDO_PREFIX.length))}`;
  return auditLabel(action);
}
