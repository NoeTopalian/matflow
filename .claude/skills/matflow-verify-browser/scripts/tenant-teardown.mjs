// Deletes one synthetic tenant's rows, child tables first, inside the caller's RLS-bypassing transaction.
// Shared by fixture.mjs (journey fixtures) and scripts/loadtest/seed.mjs (load-test clubs). No side effects on
// import: no lock, no database URL; the caller owns the transaction and the ownership checks.
//   onModel(model)  optional; called after each early model is deleted (fixture.mjs fault injection).

/** Delete one fixture tenant's rows (child tables first). Models the schema under test lacks are skipped. */
export async function deleteTenant(tx, tenantId, { onModel } = {}) {
  const del = async (model, where) => { if (tx[model]) await tx[model].deleteMany({ where }); };
  for (const m of ["auditLog", "emailLog", "magicLinkToken", "passwordResetToken", "attendanceRecord", "memberStatusEvent", "memberPhoto", "importJob", "payment", "classMembershipTier"]) {
    await del(m, { tenantId });
    if (onModel) onModel(m);
  }
  // Class packs a journey gave a member (allowance-eligibility, scanner-override): the redemption first, then the
  // member's pack (it references the member), then the pack template.
  await del("classPackRedemption", { memberPack: { tenantId } });
  await del("memberClassPack", { tenantId });
  await del("classPack", { tenantId });
  await tx.$executeRawUnsafe(`delete from "LoginEvent" where "tenantId" = $1`, tenantId);
  await tx.$executeRawUnsafe(`delete from "PasswordHistory" where "userId" in (select id from "User" where "tenantId" = $1)`, tenantId);
  const rankIds = (await tx.memberRank.findMany({ where: { member: { tenantId } }, select: { id: true } })).map((r) => r.id);
  await tx.rankHistory.deleteMany({ where: { memberRankId: { in: rankIds } } });
  await tx.memberRank.deleteMany({ where: { id: { in: rankIds } } });
  await tx.rankSystem.deleteMany({ where: { tenantId } });
  const classIds = (await tx.class.findMany({ where: { tenantId }, select: { id: true } })).map((x) => x.id);
  // Bookings and squad lists reference the class without a cascade; the membership list cascades.
  await del("classSubscription", { classId: { in: classIds } });
  await del("classRoster", { classId: { in: classIds } });
  await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
  await tx.classInstance.deleteMany({ where: { classId: { in: classIds } } });
  await tx.class.deleteMany({ where: { tenantId } });
  // Mats: the tenant link is RESTRICT, so they go before the tenant (their classes have just gone).
  await del("mat", { tenantId });
  await tx.membershipTier.deleteMany({ where: { tenantId } });
  await tx.member.deleteMany({ where: { tenantId } });
  await tx.user.deleteMany({ where: { tenantId } });
  await tx.tenant.deleteMany({ where: { id: tenantId } });
}
