/**
 * Sandbox settings regression coverage:
 * - persisted tool env validates and round-trips atomically-owned FORGE_DATA_DIR state
 * - bash/process tool shells receive configured env
 * - sandbox filesystem overrides include ls path-guard behavior, not only read/write/bash
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "pi-forge-sandbox-test-"));
const workspace = join(root, "workspace");
process.env.WORKSPACE_PATH = workspace;
process.env.FORGE_DATA_DIR = join(root, "data");
process.env.PI_CONFIG_DIR = join(root, "pi");
process.env.SESSION_DIR = join(root, "sessions");
process.env.SERVE_CLIENT = "false";
process.env.AGENT_TOOL_SANDBOX_ENABLED = "false";

const failures: string[] = [];
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const { readSandboxSettings, writeSandboxSettings, validateSandboxToolEnv } =
  await import("../packages/server/src/sandbox-settings.js");
const { createForgeBashOperations } =
  await import("../packages/server/src/agent-bash-operations.js");
const { createSandboxedToolDefinitions } =
  await import("../packages/server/src/agent-tool-overrides.js");
const { createProcessTool } = await import("../packages/server/src/processes/tool.js");
const { processManager } = await import("../packages/server/src/processes/manager.js");

try {
  console.log("sandbox settings");
  const initial = await readSandboxSettings();
  assert("default toolEnv is empty", Object.keys(initial.toolEnv).length === 0);

  await writeSandboxSettings({ toolEnv: { FOO: "bar", EMPTY: "" } });
  const stored = await readSandboxSettings();
  assert("toolEnv round-trips", stored.toolEnv.FOO === "bar" && stored.toolEnv.EMPTY === "");

  let rejected = false;
  try {
    validateSandboxToolEnv({ "BAD-NAME": "x" });
  } catch {
    rejected = true;
  }
  assert("invalid env names rejected", rejected);

  console.log("tool env injection");
  await mkdir(workspace, { recursive: true });
  const bashOps = createForgeBashOperations(workspace, { PI_FORGE_SANDBOX_TEST: "bash-ok" });
  let output = "";
  await bashOps.exec('printf %s "$PI_FORGE_SANDBOX_TEST"', workspace, {
    signal: undefined,
    onData: (chunk: Buffer) => {
      output += chunk.toString("utf8");
    },
  });
  assert("bash tool receives sandbox env", output === "bash-ok", output);

  const processTool = createProcessTool("session-test", workspace, {
    PI_FORGE_SANDBOX_TEST: "process-ok",
  });
  const call = (params: Record<string, unknown>) =>
    processTool.execute("call", params, undefined, undefined, {}) as Promise<{
      details: Record<string, unknown>;
    }>;
  const start = await call({
    action: "start",
    name: "env-check",
    command: 'printf %s "$PI_FORGE_SANDBOX_TEST"',
  });
  assert("process start succeeds", start.details.success === true, JSON.stringify(start.details));
  const pid = (start.details.process as { id: string } | undefined)?.id ?? "";
  await new Promise((resolve) => setTimeout(resolve, 250));
  const out = await call({ action: "output", id: pid });
  const stdout = ((out.details.output as { stdout: string[] }).stdout ?? []).join("");
  assert("process tool receives sandbox env", stdout.includes("process-ok"), stdout);
  processManager.disposeSession("session-test");

  console.log("filesystem sandbox overrides");
  await writeFile(join(workspace, "inside.txt"), "ok", "utf8");
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "outside.txt"), "no", "utf8");
  const ls = createSandboxedToolDefinitions(workspace).find((tool) => tool.name === "ls");
  assert("sandbox override includes ls", ls !== undefined);
  const insideResult = await ls!.execute("ls-ok", { path: "." }, undefined, undefined, {});
  const insideText = JSON.stringify(insideResult);
  assert(
    "ls can list inside workspace",
    insideText.includes("inside.txt"),
    insideText.slice(0, 200),
  );
  let blockedText = "";
  try {
    const blockedResult = await ls!.execute(
      "ls-block",
      { path: outside },
      undefined,
      undefined,
      {},
    );
    blockedText = JSON.stringify(blockedResult);
  } catch (err) {
    blockedText = err instanceof Error ? err.message : String(err);
  }
  assert(
    "ls blocks outside workspace",
    blockedText.includes("outside allowed roots") || blockedText.includes("not allowed"),
    blockedText.slice(0, 300),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("\nSandbox settings tests passed");
