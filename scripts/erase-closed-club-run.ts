/**
 * The work behind scripts/erase-closed-club.mjs — run only through that runner, which checks the arguments, the
 * context (by hand, never automatic) and the database target first. See it for usage and exit codes.
 */
async function run(): Promise<number> {
  const tenantId = process.env.ERASE_TENANT_ID ?? "";
  const reason = process.env.ERASE_REASON ?? "";
  const confirm = process.env.ERASE_CONFIRM === "1";
  if (!tenantId || !reason) {
    console.error("REFUSED: run this through scripts/erase-closed-club.mjs");
    return 2;
  }
  // Imported only after the runner's guard, so nothing connects before it passes.
  const { withRlsBypass } = await import("../lib/prisma-tenant");
  const { purgeTenantById } = await import("../lib/tenant-purge");
  const { isTenantRowBusyError } = await import("../lib/tenant-lifecycle");

  const club = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true, deletedAt: true, purgeStartedAt: true, _count: { select: { members: true } } } }),
  );
  if (!club) {
    console.error(`REFUSED: no club with id ${tenantId}`);
    return 2;
  }
  console.log(JSON.stringify({ club: { id: club.id, slug: club.slug, closedAt: club.deletedAt, erasureStartedAt: club.purgeStartedAt, members: club._count.members } }));
  if (!club.deletedAt) {
    console.error("REFUSED: this club is open. A club is erased only once it is closed (hub → club page → Close gym).");
    return 2;
  }
  if (!confirm) {
    console.log("Not erased: add --confirm to erase this club permanently. Nothing was changed.");
    return 3;
  }

  try {
    const outcome = await purgeTenantById(tenantId, new Date(), () => false, { writtenRequest: reason });
    console.log(JSON.stringify({ outcome }));
    if (outcome.kind === "purged") return 0;
    if (outcome.kind === "partial") console.log("Partly erased: run the same command again; it resumes.");
    return 3;
  } catch (e) {
    if (isTenantRowBusyError(e)) {
      console.error("BUSY: another writer holds this club's row. Try again later; any claim already recorded stands and the erasure resumes.");
      return 75;
    }
    console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

run().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
