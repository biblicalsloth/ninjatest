// Env loading for the local ingest scripts, with `.env.local` winning over the
// ambient shell environment.
//
// Why not process.loadEnvFile(): it refuses to override an already-set
// process.env var, so ANY stale shell export silently beats the file. That is
// not hypothetical — a revoked OPENROUTER_API_KEY exported in ~/.zshrc shadowed
// the real key in .env.local, and OpenRouter's rejection is a bare
// `User not found.` that names neither the key nor its source. It cost hours
// twice: once from ~/.zshrc (2026-07-16), then again from a stale key still
// living in an already-running process's env after the .zshrc fix (2026-07-17).
//
// These scripts are local-only (CLAUDE.md: "local ingest scripts only" — they
// need SUPABASE_SERVICE_ROLE_KEY and never run on Vercel), so .env.local is the
// declared source of truth and should behave like it. The app itself is
// unaffected: on Vercel there is no .env.local and process.env is correct.
//
// ponytail: shared .mjs, not duplicated per script. The existing "inline your
// own helpers" note in these scripts is specifically about not importing the
// .ts files (node strips types but warns); a .mjs importing a .mjs has none of
// that problem.
import { parseEnv } from "node:util";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Report by suffix, never the whole secret — enough to tell two keys apart in a
// terminal someone might paste into an issue.
const tail = (v) => (v.length > 6 ? `…${v.slice(-6)}` : "…");

// Loads .env.local into process.env, overriding what the shell already set.
// Returns the list of names that were overridden. An intentional
// `FOO=bar node scripts/x.mjs` still loses to the file, so every override is
// announced rather than swallowed — silence is what made this expensive.
export function loadEnvLocal(path = ".env.local") {
  let parsed;
  try {
    parsed = parseEnv(readFileSync(path, "utf8"));
  } catch {
    return []; // no .env.local — the ambient env is all there is
  }

  const overridden = [];
  for (const [name, fileValue] of Object.entries(parsed)) {
    const shellValue = process.env[name];
    if (shellValue !== undefined && shellValue !== fileValue) {
      overridden.push(name);
      console.warn(
        `env: ${name} — shell had ${tail(shellValue)}, using ${path}'s ${tail(fileValue)}. ` +
          `Shell export ignored; unset it (\`unset ${name}\`) to silence this.`,
      );
    }
    process.env[name] = fileValue;
  }
  return overridden;
}

// node scripts/env.mjs --self-test   (no network, no real env touched)
// Guards the one thing that matters: the file wins over a conflicting export.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { strict: assert } = await import("node:assert");
  const tmp = `.env.selftest-${process.pid}`;
  try {
    writeFileSync(tmp, "SELFTEST_KEY=from-file\nSELFTEST_ONLY_FILE=yes\n");

    process.env.SELFTEST_KEY = "from-shell";
    delete process.env.SELFTEST_ONLY_FILE;
    const overridden = loadEnvLocal(tmp);

    assert.equal(process.env.SELFTEST_KEY, "from-file", "file must beat the shell export");
    assert.deepEqual(overridden, ["SELFTEST_KEY"], "conflicting var must be reported");
    assert.equal(process.env.SELFTEST_ONLY_FILE, "yes", "file-only vars still load");

    // Same value in both is not a conflict and must stay quiet.
    assert.deepEqual(loadEnvLocal(tmp), [], "matching values must not be reported");

    // A missing file is not an error — the ambient env is then all there is.
    assert.deepEqual(loadEnvLocal(".env.does-not-exist"), []);

    console.log("env.mjs self-test: ok");
  } finally {
    rmSync(tmp, { force: true });
    delete process.env.SELFTEST_KEY;
    delete process.env.SELFTEST_ONLY_FILE;
  }
}
