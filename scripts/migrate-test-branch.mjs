// Apply pending Prisma migrations to the TEST branch only. Reads DATABASE_URL
// from .env.test (never .env, which is production) and refuses any host that is
// not the known test branch.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const REPO = "C:/Users/NoeTo/Desktop/matflow";
const env = readFileSync(`${REPO}/.env.test`, "utf8");
const m = env.match(/^DATABASE_URL=["']?([^"'\r\n]+)/m);
if (!m) throw new Error("no DATABASE_URL in .env.test");
const url = m[1];
if (!url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) {
  throw new Error("refusing: DATABASE_URL in .env.test is not the test branch");
}
console.log("[migrate-test] target host:", url.split("@")[1].split("/")[0]);
execSync("npx prisma migrate deploy", {
  stdio: "inherit",
  cwd: REPO,
  env: { ...process.env, DATABASE_URL: url },
});
