# D2-02 — Reproduction under the attacker model, mapping provenance, deletion provenance

All runs Node v24.21.0, TEST branch (ep-hidden-salad) through the guarded runners: `att/run-engine.sh` (owner role,
logged `neondb_owner`) and `q78/run-restricted.sh` (`matflow_app`, RLS_ENFORCED=1; asserted inside each file's
beforeAll). Fixtures `secd2-` / `secd2p-`; every run's teardown printed "N clubs removed, 0 rows left" (count-checked
over tenants, members, bookings, mappings, attendance, jobs, audit rows). Raw logs: `<scratchpad>/security/D2/logs/`.

## 1. tests/integration/sec-d2-import-attacker-model-db.test.ts (18 cells, REAL attendance route)

| cell | prerequisite | before D2 | after D2 |
|---|---|---|---|
| CONTROL true holder binds by name_and_email | — | pass | pass |
| CONTROL saved decision binds as decided | — | pass | pass |
| forged release row (unkeyed form) | a | refused (pending) | refused |
| raw takeover (victim deleted + record renamed/re-addressed by raw SQL) | a | **OPEN** — bound | OPEN (`it.fails`) |
| acquisition row back-dated 400 d + release row deleted | a | **OPEN** — bound | OPEN — SF-57 v2 closes |
| release + acquisition rows deleted | a | **OPEN** — bound | OPEN — SF-57 v2 closes |
| forged creation time (back-dated cuid insert) | a | **OPEN** — bound | OPEN |
| re-pointed decision (raw UPDATE targetId) | a | **bound (red)** | **refused (pending)** |
| cross-club re-point from club B's connection with the bypass | a | **bound (red)**; SF-62 reach confirmed (1 row) | **refused** |
| forged decision (raw INSERT mapping) | a | **bound (red)** | **refused** |
| forged decision + forged keyed provenance | c | **OPEN** — bound | OPEN (`it.fails`) |
| externalRef planted on another member | a | **OPEN** — bound | OPEN (`it.fails`) |
| externalRef case collision | a | refused (pending) | refused |
| externalRef exact collision | a | refused (unique index) | refused |
| release (real DELETE) + acquisition (real PATCH) | b | refused (pending) | refused |
| decision re-pointed via the real decide route: binds as decided + prior target recoverable | b | **red** ("one provenance row per decision: expected [] to have a length of 2 but got +0") | pass |
| provenance is atomic (audit write fails → decision not stored) | b | **red** ("promise resolved \"null\" instead of rejecting") | pass |
| externalRef collision via the REAL members-import commit | b | refused (existing address skipped; binds to holder) | refused |

Counts. Before (owner): 5 failed / 7 passed / 6 expected-fail. Before, SEC_D2_STRICT=1 (restricted): 11 failed / 7
passed — every OPEN cell fails with "…bound the victim's history…: expected 1 to be +0" (a real binding, not a setup
error). After: owner 12 passed / 6 expected-fail, exit 0; restricted 12 passed / 6 expected-fail, exit 0.
Mutant (restricted, `-t "DECISION|RE-POINT"`): the provenance check removed from loadClubInputs → 3 failed (re-point,
cross-club, forged); file restored and byte-compared (`cmp` identical).

## 2. Provenance inventory (brief item 3)

| mapping / value | correction made by | prior value recoverable before D2? | after D2 |
|---|---|---|---|
| ImportSourceMapping person/offering/venue (decide route → saveDecisions) | owner | **no** — upsert overwrote; the route's audit row (after commit, own tx) held counts only | append-only `import.mapping.changed` row per decision in the SAME tx: before/after {action,targetId}, keyed sourceKeyDigest, via, userId |
| offering targetId set by commit (new_class → created class) | importer | only via ImportJob.mappings.createdClasses (mutable job row) | provenance row in the commit tx (via import.commit, jobId) |
| offering targetId cleared by attendance rollback | importer | no | provenance row in the rollback tx (via import.rollback) |
| ImportSourceMapping person rows deleted by member DELETE / DSAR erase | owner | deletion recorded by the release row; mapping content is personal data | unchanged by design (erasure) |
| ImportedBooking memberId/disposition | importer | previousState snapshot per job (mutable) | unchanged — residual (needs an append-only ledger history) |
| Member.email by members-import rollback | importer | rollback deletes members (release digest in tx); refresh rollback never touches email (REFRESH_OWNED_FIELDS) | n/a |
| guardian adoption (parent address) | owner | parent-subject row with old/new KEYED digests in the tx (lane D fifth pass) | unchanged: the prior address is verifiable, not recoverable as plaintext (deliberate: no address in the audit trail) |

The importer now trusts a person→member decision only when the latest provenance row of that mapping id names the
same keyed source-key digest and the same target (lib/attendance-import.ts:174); otherwise it is held pending and
counted in `preview.people.unprovenDecisions`. Forging that row needs AUTH_SECRET (prerequisite c). Consequences:
a person decision saved before this change has no provenance row and is held pending until the owner decides again
(safe direction; production has no attendance-import decisions as far as this lane can see — UNVERIFIED, production
not read); an AUTH_SECRET rotation does the same to every saved person decision.

## 3. tests/integration/sec-d2-deletion-provenance-db.test.ts (16 cells, REAL routes)

Per path: (i) succeeds and records the keyed release digest; (ii) a crash injected at that path's audit write must not
leave the address released-but-undigested; (iii) a back-dated record planted at the released address by raw SQL (no
acquisition row) does not receive the history through the REAL import. Control: the same plant at a never-released
address binds (so the digest is what refuses).

| path | before D2 (both roles) | after D2 (both roles) |
|---|---|---|
| member DELETE (app/api/members/[id]) | (ii) **red**: "address released with no digest (status 500)" — audit written after the commit | 3/3 |
| child DELETE (app/api/member/children/[id]) | (i) **red** no digest at all; (ii) **red**; (iii) **red**: planted record received the history | 3/3 |
| staff DELETE (app/api/staff/[id]) | (ii) **red** | 3/3 |
| DSAR erase | 3/3 (already in the tx) | 3/3 |
| members-import rollback | 3/3 (already in the tx) | 3/3 |

Before: 5 failed / 11 passed on each role. After: 16/16 owner, 16/16 matflow_app, exit 0.
Fix: the three routes write their audit row with `logAudit({ tx })` inside the deletion transaction (a failure rolls
the deletion back); the child route now records `releasedEmailSha256` for a non-synthesised address; member DELETE's
row records `photosQueued` (files are removed after the commit; the response still reports `photosDeleted`).

## D3 correction (lane D3, 9 Oct 2026, after review R4)

§2 above says "forging that row needs AUTH_SECRET (prerequisite c)". That was wrong: the D2 digest was a keyed MAC over
`import-source-key:v1:person` + the source key ONLY, so the attacker did not have to compute it — they copied it, onto
a re-pointed mapping in the same club (R4 P1, database password only) or from a decision minted through the real
decide route in their own club (R4 P2, password + an owner session anywhere). It also ran with an EMPTY key in every
test run (the harness sets no secret).

What the proof covers now (lib/attendance-import.ts, `provenanceCanonical` / `recordMappingChange` /
`provenanceVouches`): each `import.mapping.changed` row carries `prev` and `proof`. `proof` = HMAC-SHA256 under a
sub-key (HMAC(signing secret, `matflow.import-mapping-provenance.v2`); the signing secret is NEXTAUTH_SECRET, else
AUTH_SECRET, as before) over the canonical JSON array (version, club id, mapping id, kind, keyed source-key digest,
before {action, targetId}, after {action, targetId}, the row's own createdAt in ms, prev). `prev` is the previous row's
proof for the same mapping (a fixed genesis constant for the first). The importer trusts a person decision only when
the mapping's LATEST row (by createdAt; a tie at the top is refused) verifies under the current key, matches the
mapping as stored (kind, source-key digest, after = the mapping's action and target), links to the row before it, and
is not dated more than 5 s in the future. An empty signing secret mints no proof (`proof: null`) and verifies none.
Copying a row to another mapping, another club, another date or another chain position breaks the MAC.

What it still does not cover: (c) full app-environment compromise — whoever holds the signing secret mints any proof
(the sec-d2 OPEN (c) cell now mints a D3 proof with the key and still binds, as it should be reported); (a) with
AuditLog DELETE can remove the NEWEST rows and re-point the mapping to an EARLIER owner decision for that mapping
(rollback, not forgery — OPEN cell in sec-d3-provenance-forgery-db, closed by SF-57 v2 append-only, not by a MAC);
(a) can always make a decision untrusted (insert a newer or future-dated row, delete an earlier one) — denial only,
the booking stays pending. Offering and venue decisions are still not checked against provenance when loaded. Rows
written before D3 carry no proof: every saved person decision is held pending until the owner decides again (safe
direction; production unverified). Evidence: docs/security/evidence/D3/.
