/**
 * Agent tool identity sandbox tests.
 *
 * Unit-style coverage for startup config validation, path policy,
 * sandboxed SDK tool overrides, and @file expansion scoping.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const tmp = mkdtempSync(resolve(tmpdir(), "pi-agent-tool-sandbox-"));
const workspace = resolve(tmp, "workspace");
const project = resolve(workspace, "project-a");
const shared = resolve(workspace, "shared");
const piConfig = resolve(workspace, ".pi", "agent");
const forgeData = resolve(tmp, "forge-data");
const outside = resolve(tmp, "outside");
mkdirSync(workspace, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(shared, { recursive: true });
mkdirSync(piConfig, { recursive: true });
mkdirSync(forgeData, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(resolve(project, "hello.txt"), "hello workspace\n");
writeFileSync(resolve(shared, "shared.txt"), "hello shared workspace\n");
writeFileSync(resolve(outside, "secret.txt"), "outside secret\n");
writeFileSync(resolve(piConfig, "profile.json"), "profile ok\n");
writeFileSync(resolve(piConfig, "auth.json"), "secret auth\n");
writeFileSync(resolve(forgeData, "jwt-secret"), "secret jwt\n");
symlinkSync(resolve(outside, "secret.txt"), resolve(project, "escape-link"));

process.env.NODE_ENV = "test";
process.env.HOME = tmp;
process.env.WORKSPACE_PATH = workspace;
process.env.PI_CONFIG_DIR = piConfig;
process.env.FORGE_DATA_DIR = forgeData;
process.env.AGENT_TOOL_SANDBOX_ENABLED = "true";
process.env.AGENT_TOOL_UID = String(process.getuid?.() ?? 1000);
process.env.AGENT_TOOL_GID = String(process.getgid?.() ?? 1000);
process.env.SERVE_CLIENT = "false";

try {
  console.log("config validation");
  {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      HOME: tmp,
      WORKSPACE_PATH: workspace,
      PI_CONFIG_DIR: piConfig,
      FORGE_DATA_DIR: forgeData,
      AGENT_TOOL_SANDBOX_ENABLED: "true",
    };
    delete baseEnv.AGENT_TOOL_UID;
    delete baseEnv.AGENT_TOOL_GID;
    const missing = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import ${JSON.stringify(resolve(repoRoot, "packages/server/dist/config.js"))}`,
      ],
      { env: baseEnv, encoding: "utf8" },
    );
    assert("enabled without UID/GID fails", missing.status !== 0, missing.stderr);

    const ldapRaw = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import ${JSON.stringify(resolve(repoRoot, "packages/server/dist/config.js"))}`,
      ],
      {
        env: { ...baseEnv, AGENT_TOOL_UID: "1", AGENT_TOOL_GID: "1", LDAP_BIND_PASSWORD: "raw" },
        encoding: "utf8",
      },
    );
    assert("LDAP raw env accepted", ldapRaw.status === 0, ldapRaw.stderr);

    const ldapFile = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import ${JSON.stringify(resolve(repoRoot, "packages/server/dist/config.js"))}`,
      ],
      {
        env: {
          ...baseEnv,
          AGENT_TOOL_UID: "1",
          AGENT_TOOL_GID: "1",
          LDAP_BIND_PASSWORD_FILE: resolve(outside, "secret.txt"),
        },
        encoding: "utf8",
      },
    );
    assert("LDAP file refs rejected", ldapFile.status !== 0, ldapFile.stderr);
  }

  const { resolveAgentToolPath } = (await import(
    resolve(repoRoot, "packages/server/dist/agent-tool-policy.js")
  )) as { resolveAgentToolPath: (workspacePath: string, requestedPath: string) => string };
  const { createSandboxedToolDefinitions } = (await import(
    resolve(repoRoot, "packages/server/dist/agent-tool-overrides.js")
  )) as { createSandboxedToolDefinitions: (workspacePath: string) => any[] };
  const { expandFileReferences } = (await import(
    resolve(repoRoot, "packages/server/dist/file-references.js")
  )) as { expandFileReferences: (text: string, workspacePath: string) => Promise<string> };

  function allowed(label: string, requested: string): void {
    try {
      resolveAgentToolPath(project, requested);
      assert(label, true);
    } catch (err) {
      assert(label, false, (err as Error).message);
    }
  }
  function denied(label: string, requested: string): void {
    try {
      resolveAgentToolPath(project, requested);
      assert(label, false, "allowed unexpectedly");
    } catch (err) {
      assert(
        label,
        (err as Error).message.startsWith("agent_tool_path_denied"),
        (err as Error).message,
      );
    }
  }

  console.log("\npath policy");
  allowed("relative project path allowed", "hello.txt");
  allowed("absolute project path allowed", resolve(project, "hello.txt"));
  allowed("absolute sibling under WORKSPACE_PATH allowed", resolve(shared, "shared.txt"));
  allowed("allowed pi config non-secret file allowed", resolve(piConfig, "profile.json"));
  denied("auth.json rejected", resolve(piConfig, "auth.json"));
  denied("models.json rejected", resolve(piConfig, "models.json"));
  denied("settings.json rejected", resolve(piConfig, "settings.json"));
  denied("outside absolute rejected", resolve(outside, "secret.txt"));
  denied("../ escape rejected", "../../outside/secret.txt");
  denied("symlink escape rejected", "escape-link");
  denied("/proc/self/environ rejected", "/proc/self/environ");
  denied("FORGE_DATA_DIR rejected", resolve(forgeData, "jwt-secret"));

  console.log("\ntool overrides");
  const tools = new Map(createSandboxedToolDefinitions(project).map((tool) => [tool.name, tool]));
  const read = tools.get("read")!;
  const write = tools.get("write")!;
  const ls = tools.get("ls")!;
  const grep = tools.get("grep")!;
  const find = tools.get("find")!;
  const edit = tools.get("edit")!;
  const okRead = await read.execute("t1", { path: "hello.txt" }, undefined, undefined, {});
  assert("read in-workspace works", JSON.stringify(okRead).includes("hello workspace"));
  await assertRejects("read outside rejected", () =>
    read.execute("t2", { path: resolve(outside, "secret.txt") }, undefined, undefined, {}),
  );
  await write.execute("t3", { path: "new.txt", content: "new content" }, undefined, undefined, {});
  const newRead = await read.execute("t4", { path: "new.txt" }, undefined, undefined, {});
  assert("write in-workspace works", JSON.stringify(newRead).includes("new content"));
  await assertRejects("write outside rejected", () =>
    write.execute(
      "t5",
      { path: resolve(outside, "x.txt"), content: "x" },
      undefined,
      undefined,
      {},
    ),
  );
  await assertRejects("ls outside rejected", () =>
    ls.execute("t6", { path: outside }, undefined, undefined, {}),
  );
  await assertRejects("grep outside rejected", () =>
    grep.execute("t7", { pattern: "secret", path: outside }, undefined, undefined, {}),
  );
  await assertRejects("find outside rejected", () =>
    find.execute("t8", { pattern: "*", path: outside }, undefined, undefined, {}),
  );
  await assertRejects("edit outside rejected", () =>
    edit.execute(
      "t9",
      { path: resolve(outside, "secret.txt"), edits: [{ oldText: "outside", newText: "inside" }] },
      undefined,
      undefined,
      {},
    ),
  );
  const piRead = await read.execute(
    "t10",
    { path: resolve(piConfig, "profile.json") },
    undefined,
    undefined,
    {},
  );
  assert("allowed pi config non-secret read works", JSON.stringify(piRead).includes("profile ok"));
  await assertRejects("protected pi config file rejected", () =>
    read.execute("t11", { path: resolve(piConfig, "auth.json") }, undefined, undefined, {}),
  );

  console.log("\n@file expansion");
  const expandedWorkspace = await expandFileReferences("see @hello.txt", project);
  assert("workspace expands", expandedWorkspace.includes("hello workspace"));
  const expandedPi = await expandFileReferences(
    `see @${resolve(piConfig, "profile.json")}`,
    project,
  );
  assert("allowed pi config non-secret expands", expandedPi.includes("profile ok"));
  const deniedAuth = await expandFileReferences(`see @${resolve(piConfig, "auth.json")}`, project);
  assert("protected pi config rejected", deniedAuth.includes("not included"));
  const deniedOutside = await expandFileReferences(
    `see @${resolve(outside, "secret.txt")}`,
    project,
  );
  assert("outside rejected", deniedOutside.includes("not included"));
  const deniedSymlink = await expandFileReferences("see @escape-link", project);
  assert("symlink escape rejected", deniedSymlink.includes("not included"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

async function assertRejects(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    assert(label, false, "resolved unexpectedly");
  } catch (err) {
    const message = (err as Error).message;
    assert(
      label,
      message.includes("agent_tool_path_denied") || message.includes("Path not found"),
      message,
    );
  }
}

if (failures > 0) {
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}
console.log("\nagent-tool-sandbox tests passed");
