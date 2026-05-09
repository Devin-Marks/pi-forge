/**
 * CLI argument parser tests for `pi-forge --flag` support.
 *
 * Pure unit-style — imports `parseCliArgs` from the compiled
 * `dist/server/cli.js` and asserts:
 *
 * - Every declared flag in FLAG_DEFS round-trips to its env var.
 * - Booleans accept both `--flag value` and `--flag=value`, plus
 *   the bare `--flag` (true) and `--no-flag` (false) shortcuts.
 * - Numeric flags reject non-numeric input.
 * - Sensitive flags (`--ui-password`, `--api-key`, `--jwt-secret`)
 *   accept `@<path>` and read from disk.
 * - `--help` and `--version` are recognized.
 * - Unknown flags + positional args produce parse errors instead of
 *   being silently absorbed (regression guard — any new flag the
 *   user typos should surface, not be ignored).
 *
 * Does NOT boot the server — the bin shim integration is so thin
 * (4 lines: parse, apply, import, start) that exercising it would be
 * a pure smoke test. The unit-level coverage here is what we trust.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface ParseResult {
  envWrites: { key: string; value: string }[];
  helpRequested: boolean;
  versionRequested: boolean;
  errors: string[];
  positionals: string[];
}

interface FlagDef {
  name: string;
  env: string;
  type: "string" | "number" | "boolean" | "list";
  group: string;
  desc: string;
  defaultText: string;
  sensitive?: boolean;
}

const cliModule = (await import(resolve(repoRoot, "packages/server/dist/cli.js"))) as {
  parseCliArgs: (argv: string[]) => ParseResult;
  applyCliEnv: (parsed: ParseResult) => void;
  buildHelpText: (version: string) => string;
  FLAG_DEFS: readonly FlagDef[];
};
const { parseCliArgs, buildHelpText, FLAG_DEFS } = cliModule;

function envFor(parsed: ParseResult, key: string): string | undefined {
  return parsed.envWrites.find((w) => w.key === key)?.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. every declared flag round-trips to its env var
// ─────────────────────────────────────────────────────────────────────────────
console.log("flag round-trip");
{
  const tmp = mkdtempSync(resolve(tmpdir(), "pi-cli-flags-"));
  try {
    const secretFile = resolve(tmp, "secret.txt");
    writeFileSync(secretFile, "from-disk-value\n");

    const argv: string[] = [];
    const expected = new Map<string, string>();
    for (const def of FLAG_DEFS) {
      switch (def.type) {
        case "string":
          if (def.sensitive) {
            argv.push(`--${def.name}`, `@${secretFile}`);
            expected.set(def.env, "from-disk-value");
          } else {
            argv.push(`--${def.name}`, `value-for-${def.name}`);
            expected.set(def.env, `value-for-${def.name}`);
          }
          break;
        case "number":
          argv.push(`--${def.name}`, "1234");
          expected.set(def.env, "1234");
          break;
        case "boolean":
          argv.push(`--${def.name}`, "true");
          expected.set(def.env, "true");
          break;
        case "list":
          argv.push(`--${def.name}`, "a,b,c");
          expected.set(def.env, "a,b,c");
          break;
      }
    }
    const parsed = parseCliArgs(argv);
    assert(
      "no parse errors when every flag is set",
      parsed.errors.length === 0,
      parsed.errors.join("; "),
    );
    for (const [envKey, want] of expected) {
      assert(`${envKey} → ${want}`, envFor(parsed, envKey) === want);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. boolean coercion: bare flag, =value, and --no-foo
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nboolean coercion");
{
  const bare = parseCliArgs(["--minimal-ui"]);
  assert("bare --minimal-ui → true", envFor(bare, "MINIMAL_UI") === "true");

  const eqFalse = parseCliArgs(["--minimal-ui=false"]);
  assert("--minimal-ui=false → false", envFor(eqFalse, "MINIMAL_UI") === "false");

  const noFlag = parseCliArgs(["--no-serve-client"]);
  assert("--no-serve-client → false", envFor(noFlag, "SERVE_CLIENT") === "false");

  const onValue = parseCliArgs(["--minimal-ui", "on"]);
  assert("--minimal-ui on → true", envFor(onValue, "MINIMAL_UI") === "true");

  const yesValue = parseCliArgs(["--expose-docs", "yes"]);
  assert("--expose-docs yes → true", envFor(yesValue, "EXPOSE_DOCS") === "true");

  const bogus = parseCliArgs(["--minimal-ui", "maybe"]);
  assert(
    "--minimal-ui maybe is rejected",
    bogus.errors.some((e) => e.includes("--minimal-ui")) && bogus.errors.length > 0,
    bogus.errors.join("; "),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. numeric coercion
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nnumeric coercion");
{
  const ok = parseCliArgs(["--port", "4000"]);
  assert("--port 4000 → 4000", envFor(ok, "PORT") === "4000" && ok.errors.length === 0);

  const float = parseCliArgs(["--port", "3.14"]);
  assert(
    "--port 3.14 is rejected",
    float.errors.some((e) => e.includes("--port")),
    float.errors.join("; "),
  );

  const negative = parseCliArgs(["--port", "-1"]);
  assert(
    "--port -1 is rejected",
    negative.errors.some((e) => e.includes("--port")),
    negative.errors.join("; "),
  );

  const word = parseCliArgs(["--port", "abc"]);
  assert(
    "--port abc is rejected",
    word.errors.some((e) => e.includes("--port")),
    word.errors.join("; "),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. @file syntax for sensitive flags
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n@file syntax");
{
  const tmp = mkdtempSync(resolve(tmpdir(), "pi-cli-secret-"));
  try {
    const secretFile = resolve(tmp, "api-key.txt");
    writeFileSync(secretFile, "  sk-test-12345\n\n");
    const ok = parseCliArgs(["--api-key", `@${secretFile}`]);
    assert("--api-key @file → trimmed file content", envFor(ok, "API_KEY") === "sk-test-12345");

    const missing = parseCliArgs(["--api-key", `@${tmp}/does-not-exist`]);
    assert(
      "--api-key @missing-file is rejected",
      missing.errors.some((e) => e.includes("--api-key")),
      missing.errors.join("; "),
    );

    const empty = parseCliArgs(["--api-key", "@"]);
    assert(
      "--api-key @ alone is rejected",
      empty.errors.some((e) => e.includes("--api-key")),
      empty.errors.join("; "),
    );

    const literal = parseCliArgs(["--api-key", "literal-value"]);
    assert(
      "--api-key literal-value is preserved",
      envFor(literal, "API_KEY") === "literal-value" && literal.errors.length === 0,
    );

    const fileWithEmpty = resolve(tmp, "blank.txt");
    writeFileSync(fileWithEmpty, "   \n");
    const blank = parseCliArgs(["--api-key", `@${fileWithEmpty}`]);
    assert(
      "--api-key @blank-file is rejected as empty",
      blank.errors.some((e) => e.includes("--api-key")),
      blank.errors.join("; "),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. --help and --version
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nhelp + version");
{
  const help = parseCliArgs(["--help"]);
  assert("--help is recognized", help.helpRequested === true);
  const helpShort = parseCliArgs(["-h"]);
  assert("-h is recognized", helpShort.helpRequested === true);
  const version = parseCliArgs(["--version"]);
  assert("--version is recognized", version.versionRequested === true);
  const versionShort = parseCliArgs(["-v"]);
  assert("-v is recognized", versionShort.versionRequested === true);

  const helpText = buildHelpText("9.9.9");
  assert("buildHelpText embeds the version", helpText.startsWith("pi-forge 9.9.9"));
  const helpGroups = ["Network", "Paths", "Authentication", "Features", "Rate limits", "Terminal"];
  assert(
    "buildHelpText lists at least one flag from each group",
    helpGroups.every((g) => helpText.includes(`${g}:`)),
  );
  assert("buildHelpText mentions @file convention", helpText.includes("@<path>"));
  assert("buildHelpText mentions --no-<flag> negation", helpText.includes("--no-<flag>"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. unknown flags + positionals are rejected (no silent ignore)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nstrictness");
{
  const unknown = parseCliArgs(["--made-up-flag", "value"]);
  assert("unknown flag is rejected", unknown.errors.length > 0, unknown.errors.join("; "));

  const pos = parseCliArgs(["start"]);
  assert(
    "positional arg is rejected",
    pos.errors.some((e) => e.toLowerCase().includes("positional")),
    pos.errors.join("; "),
  );

  const empty = parseCliArgs([]);
  assert(
    "empty argv produces no errors and no env writes",
    empty.errors.length === 0 && empty.envWrites.length === 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. flag overrides env (verified by applyCliEnv mutating process.env)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\napplyCliEnv overrides existing env");
{
  const prev = process.env.PORT;
  try {
    process.env.PORT = "9999";
    const parsed = parseCliArgs(["--port", "8888"]);
    cliModule.applyCliEnv(parsed);
    assert("--port wins over pre-existing PORT", process.env.PORT === "8888");

    const parsedNoPort = parseCliArgs(["--minimal-ui"]);
    process.env.PORT = "7777";
    cliModule.applyCliEnv(parsedNoPort);
    assert("PORT is preserved when --port is absent", process.env.PORT === "7777");
  } finally {
    if (prev === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = prev;
    }
  }
}

console.log("");
if (failures > 0) {
  console.log(`FAIL  ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PASS  test-cli-flags");
