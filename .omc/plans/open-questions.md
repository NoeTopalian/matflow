# Open Questions

## initial-test-plan - 2026-04-18
- [ ] Should the streak extraction refactor (moving `getWeekKey`/`calculateStreak` to `lib/streak.ts`) be done as a prerequisite task or inline during test writing? -- Affects whether Tier 1.1 tests can be written without touching production code first.
- [ ] Is there a preferred test DB strategy for integration tests (in-memory SQLite vs. file-based test.db vs. Prisma's `--force-reset` on each run)? -- Affects Tier 2 setup complexity and CI speed.
- [ ] Should the `admin` role be allowed to create announcements? Currently excluded from `["owner", "manager"]` check in `app/api/announcements/route.ts`. -- If this is a bug rather than intentional, the test assertion in Tier 1.3 would change.
- [ ] Are there timezone concerns for the streak algorithm? `getWeekKey` uses `new Date()` local time. If the server runs in UTC but members are in BST, Monday boundaries shift. -- May need a Tier 1.1 test case for timezone edge.
