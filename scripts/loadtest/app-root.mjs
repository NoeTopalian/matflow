// Points the verification skill's env.mjs at this checkout (it reads MF_APP, default the current directory), so the
// load-test scripts work from any directory. Imported by lib.mjs before env.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.MF_APP ??= path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
