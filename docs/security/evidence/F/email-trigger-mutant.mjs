// Mutant for the email-lowercase invariant (SEC-088): inside ONE transaction
// that is always rolled back, disable the Member trigger, write a mixed-case
// address and show the stored value. If it comes back mixed, the test's
// assertion (stored === lowercased) discriminates the trigger's presence.
// TEST branch only; owner role (DDL needs the table owner).
import fs from "node:fs";
import { createRequire } from "node:module"; const pg = createRequire("C:/Users/NoeTo/Desktop/matflow/package.json")("pg");
const env = fs.readFileSync("C:/Users/NoeTo/Desktop/matflow/.env.test", "utf8");
const url = (env.match(/^TEST_DATABASE_URL=(.*)$/m) || [])[1]?.replace(/["\r]/g, "");
if (!url || !url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) { console.log("REFUSED"); process.exit(2); }
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query("SET lock_timeout = '3s'");
await c.query("BEGIN");
try {
  const t = (await c.query(`SELECT id FROM "Tenant" WHERE slug='totalbjj'`)).rows[0].id;
  const ins = async (label) => {
    const r = await c.query(
      `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","joinedAt","updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'secF mutant', $2, 'active','paid', now(), now()) RETURNING email`,
      [t, `secF-mutant-${label}-MiXeD@Example.COM`]);
    return r.rows[0].email;
  };
  const withTrigger = await ins("on");
  await c.query(`ALTER TABLE "Member" DISABLE TRIGGER "Member_email_lowercase"`);
  const withoutTrigger = await ins("off");
  console.log(JSON.stringify({ withTrigger, withoutTrigger,
    assertionWouldFailWithoutTrigger: withoutTrigger !== withoutTrigger.toLowerCase() }));
} finally {
  await c.query("ROLLBACK");
  await c.end();
}
const v = new pg.Client({ connectionString: url }); await v.connect();
const left = (await v.query(`SELECT count(*)::int n FROM "Member" WHERE email ILIKE 'secf-mutant-%'`)).rows[0].n;
const trig = (await v.query(`SELECT tgenabled FROM pg_trigger WHERE tgname='Member_email_lowercase'`)).rows[0].tgenabled;
console.log(JSON.stringify({ leftoverRows: left, triggerStateAfterRollback: trig }));
await v.end();
