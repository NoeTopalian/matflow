# Lane C4 mutant runner (iteration 2). Applies one mutant to lib/rate-limit.ts, runs the C4 unit test and (unless
# --unit-only) the saturation integration test under both roles through the guarded runners, then restores the
# saved file and checks it is byte-identical. Usage (repo root, Node 24 on PATH):
#   python docs/security/evidence/C4/c4-mutants.py <scratchpad> <M0|M1|M2|M3> [--unit-only]
import json, shutil, subprocess, sys, filecmp

SCR, MUT = sys.argv[1], sys.argv[2]
UNIT_ONLY = "--unit-only" in sys.argv
P = "lib/rate-limit.ts"
SAVE = f"{SCR}/security/C4/rate-limit.fixed.ts"

MUTANTS = {
    # M0: the HEAD file (1bad6ee) — unseeded memory fallback for every bucket, no store-failure log.
    "M0": None,
    # M1: fallback restored — security buckets answered from the (seeded) memory store instead of refused.
    "M1": [('    if (cls === "security") {', '    if (cls === "security" && false) {')],
    # M2: memory not seeded full — a window this instance did not watch starts at count 1, allowed.
    "M2": [("    if (now < fullUntil) {", "    if (now < fullUntil && false) {")],
    # M3: the store-failure log removed.
    "M3": [("  const seen = storeFailureLog.get(k);", "  if (k) return;\n  const seen = storeFailureLog.get(k);")],
}

shutil.copyfile(P, SAVE)
try:
    if MUT == "M0":
        head = subprocess.run(["git", "show", "HEAD:" + P], capture_output=True, check=True).stdout
        open(P, "wb").write(head)
    else:
        s = open(P, encoding="utf8", newline="").read()
        for a, b in MUTANTS[MUT]:
            assert s.count(a) == 1, (MUT, a)
            s = s.replace(a, b)
        open(P, "w", encoding="utf8", newline="").write(s)
    runs = [("unit", ["npx", "vitest", "run", "tests/unit/sec-c4-rate-limit-store-failure.test.ts"])]
    if not UNIT_ONLY:
        it = "tests/integration/sec-c4-rate-limit-saturation-db.test.ts"
        runs += [("owner", ["bash", f"{SCR}/att/run-engine.sh", it]), ("restricted", ["bash", f"{SCR}/q78/run-restricted.sh", it])]
    out = {"mutant": MUT}
    for name, cmd in runs:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf8", errors="replace", shell=(name == "unit"))
        text = r.stdout + r.stderr
        summary = [l.strip() for l in text.splitlines() if l.strip().startswith("Tests ")]
        failed = [l.strip()[:150] for l in text.splitlines() if l.strip().startswith("×")]
        out[name] = {"exit": r.returncode, "summary": summary[-1:] , "failed": failed}
    print(json.dumps(out))
finally:
    shutil.copyfile(SAVE, P)
    print(json.dumps({"restored": filecmp.cmp(SAVE, P, shallow=False)}))
