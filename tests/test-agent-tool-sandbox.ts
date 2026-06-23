/**
 * Agent tool identity sandbox tests.
 *
 * Unit-style coverage for startup config validation, path policy,
 * sandboxed SDK tool overrides, and @file expansion scoping.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const toolHome = resolve(tmp, "pi-tools-home");
const outside = resolve(tmp, "outside");
mkdirSync(workspace, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(shared, { recursive: true });
mkdirSync(piConfig, { recursive: true });
mkdirSync(forgeData, { recursive: true });
mkdirSync(toolHome, { recursive: true });
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
process.env.AGENT_TOOL_HOME = toolHome;
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
  const { toolShellEnv } = (await import(
    resolve(repoRoot, "packages/server/dist/pty-manager.js")
  )) as {
    toolShellEnv: (env?: NodeJS.ProcessEnv) => Record<string, string>;
  };
  const { importSkillsFromFiles } = (await import(
    resolve(repoRoot, "packages/server/dist/skills-export.js")
  )) as {
    importSkillsFromFiles: (
      files: { filename: string; buffer: Buffer }[],
    ) => Promise<{ imported: string[]; skipped: { name: string; reason: string }[] }>;
  };
  const { makeDirectory, writeFile, writeFileBytesRelative } = (await import(
    resolve(repoRoot, "packages/server/dist/file-manager.js")
  )) as {
    makeDirectory: (parentAbsPath: string, root: string, name: string) => Promise<string>;
    writeFile: (absPath: string, root: string, content: string) => Promise<void>;
    writeFileBytesRelative: (
      parentAbsPath: string,
      relativePath: string,
      root: string,
      source: AsyncIterable<Buffer | Uint8Array>,
      opts?: { expectedSha256?: string; overwrite?: boolean },
    ) => Promise<{ path: string; size: number; sha256: string }>;
  };

  console.log("\nsandbox shell env");
  const shellEnv = toolShellEnv({ ...process.env, HOME: "/home/pi", USER: "pi", LOGNAME: "pi" });
  assert("sandbox shell HOME uses AGENT_TOOL_HOME", shellEnv.HOME === toolHome, shellEnv.HOME);
  assert("sandbox shell USER uses tool identity", shellEnv.USER === "pi-tools", shellEnv.USER);

  async function* bufferSource(content: string): AsyncIterable<Buffer> {
    yield Buffer.from(content);
  }

  console.log("\nsandbox file-manager ownership");
  await writeFile(resolve(project, "created", "from-write.txt"), project, "created\n");
  const uploadResult = await writeFileBytesRelative(
    project,
    "uploaded/nested/from-upload.txt",
    project,
    bufferSource("uploaded\n"),
  );
  const mkdirResult = await makeDirectory(project, project, "browser-dir");
  const expectedUid = Number(process.env.AGENT_TOOL_UID);
  const expectedGid = Number(process.env.AGENT_TOOL_GID);
  for (const ownedPath of [
    resolve(project, "created"),
    resolve(project, "created", "from-write.txt"),
    resolve(project, "uploaded"),
    resolve(project, "uploaded", "nested"),
    uploadResult.path,
    mkdirResult,
  ]) {
    const st = statSync(ownedPath);
    assert(
      `sandbox-created path owned by tool identity: ${ownedPath.slice(project.length + 1)}`,
      st.uid === expectedUid && st.gid === expectedGid,
      `${st.uid}:${st.gid}`,
    );
  }

  if ((process.getuid?.() ?? 0) === 0) {
    const ownershipProject = resolve(tmp, "ownership-root-project");
    const ownershipWorkspace = resolve(tmp, "ownership-root-workspace");
    const ownershipPiConfig = resolve(tmp, "ownership-root-pi");
    const ownershipData = resolve(tmp, "ownership-root-data");
    mkdirSync(ownershipProject, { recursive: true });
    mkdirSync(ownershipWorkspace, { recursive: true });
    mkdirSync(ownershipPiConfig, { recursive: true });
    mkdirSync(ownershipData, { recursive: true });
    const ownership = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { statSync } from "node:fs";
          import { resolve } from "node:path";
          const { writeFile, writeFileBytesRelative } = await import(${JSON.stringify(
            resolve(repoRoot, "packages/server/dist/file-manager.js"),
          )});
          const project = ${JSON.stringify(ownershipProject)};
          async function* bufferSource(content) { yield Buffer.from(content); }
          await writeFile(resolve(project, "new", "file.txt"), project, "x");
          const uploaded = await writeFileBytesRelative(project, "drop/inner/upload.txt", project, bufferSource("y"));
          const statOwner = (path) => {
            const st = statSync(path);
            return { uid: st.uid, gid: st.gid };
          };
          console.log(JSON.stringify({
            writeDir: statOwner(resolve(project, "new")),
            writeFile: statOwner(resolve(project, "new", "file.txt")),
            uploadDir: statOwner(resolve(project, "drop", "inner")),
            uploadFile: statOwner(uploaded.path),
          }));
        `,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          WORKSPACE_PATH: ownershipWorkspace,
          PI_CONFIG_DIR: ownershipPiConfig,
          FORGE_DATA_DIR: ownershipData,
          SESSION_DIR: resolve(ownershipWorkspace, ".pi", "sessions"),
          AGENT_TOOL_SANDBOX_ENABLED: "true",
          AGENT_TOOL_UID: "1",
          AGENT_TOOL_GID: "1",
          AGENT_TOOL_HOME: toolHome,
          SERVE_CLIENT: "false",
        },
        encoding: "utf8",
      },
    );
    assert(
      "root can chown file-manager creates to configured UID/GID",
      ownership.status === 0,
      ownership.stderr,
    );
    const ownershipJson = ownership.stdout.trim().split(/\r?\n/).at(-1) ?? "{}";
    const ownershipStats = JSON.parse(ownershipJson) as Record<
      string,
      { uid: number; gid: number }
    >;
    for (const [label, st] of Object.entries(ownershipStats)) {
      assert(
        `root-created ${label} owned by 1:1`,
        st.uid === 1 && st.gid === 1,
        `${st.uid}:${st.gid}`,
      );
    }
  } else {
    assert("root-only ownership coverage skipped as non-root", true);
  }

  console.log("\nskills import permissions");
  const skillsImport = await importSkillsFromFiles([
    { filename: "demo/SKILL.md", buffer: Buffer.from("# Demo skill\n") },
    { filename: "demo/assets/images/icon.txt", buffer: Buffer.from("icon\n") },
  ]);
  assert("skills import succeeds", skillsImport.imported.includes("demo/SKILL.md"));
  assert(
    "nested skills import succeeds",
    skillsImport.imported.includes("demo/assets/images/icon.txt"),
  );
  const importedSkill = resolve(piConfig, "skills", "demo", "SKILL.md");
  const importedSkillDirs = [
    resolve(piConfig, "skills", "demo"),
    resolve(piConfig, "skills", "demo", "assets"),
    resolve(piConfig, "skills", "demo", "assets", "images"),
  ];
  const skillMode = statSync(importedSkill).mode & 0o777;
  assert(
    "imported skill file is writable by sandbox identity or fallback",
    (skillMode & 0o600) === 0o600 || (skillMode & 0o006) === 0o006,
    skillMode.toString(8),
  );
  for (const dir of importedSkillDirs) {
    const skillDirMode = statSync(dir).mode & 0o777;
    assert(
      `imported skill dir ${dir.slice(piConfig.length + 1)} is writable/searchable`,
      (skillDirMode & 0o700) === 0o700 || (skillDirMode & 0o007) === 0o007,
      skillDirMode.toString(8),
    );
  }

  if ((process.getuid?.() ?? 0) !== 0) {
    const fallbackPiConfig = resolve(tmp, "fallback-pi");
    const fallbackWorkspace = resolve(tmp, "fallback-workspace");
    const fallbackData = resolve(tmp, "fallback-data");
    mkdirSync(fallbackWorkspace, { recursive: true });
    mkdirSync(fallbackData, { recursive: true });
    const fallback = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { statSync } from "node:fs";
          import { resolve } from "node:path";
          const { importSkillsFromFiles } = await import(${JSON.stringify(
            resolve(repoRoot, "packages/server/dist/skills-export.js"),
          )});
          await importSkillsFromFiles([{ filename: "fallback/assets/file.txt", buffer: Buffer.from("x") }]);
          const root = resolve(${JSON.stringify(fallbackPiConfig)}, "skills", "fallback");
          const assets = resolve(root, "assets");
          const file = resolve(assets, "file.txt");
          console.log(JSON.stringify({
            root: statSync(root).mode & 0o777,
            assets: statSync(assets).mode & 0o777,
            file: statSync(file).mode & 0o777,
          }));
        `,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          WORKSPACE_PATH: fallbackWorkspace,
          PI_CONFIG_DIR: fallbackPiConfig,
          FORGE_DATA_DIR: fallbackData,
          SESSION_DIR: resolve(fallbackWorkspace, ".pi", "sessions"),
          AGENT_TOOL_SANDBOX_ENABLED: "true",
          AGENT_TOOL_UID: "1",
          AGENT_TOOL_GID: "1",
          AGENT_TOOL_HOME: toolHome,
          SERVE_CLIENT: "false",
        },
        encoding: "utf8",
      },
    );
    assert("EPERM fallback import succeeds in test", fallback.status === 0, fallback.stderr);
    assert(
      "EPERM fallback logs server warning",
      fallback.stderr.includes("unable to chown restored skills"),
      fallback.stderr,
    );
    const fallbackJson = fallback.stdout.trim().split(/\r?\n/).at(-1) ?? "{}";
    const fallbackModes = JSON.parse(fallbackJson) as {
      root: number;
      assets: number;
      file: number;
    };
    assert(
      "EPERM fallback makes nested dirs writable",
      fallbackModes.root === 0o777 && fallbackModes.assets === 0o777,
      fallback.stdout,
    );
    assert("EPERM fallback makes file writable", fallbackModes.file === 0o666, fallback.stdout);
  } else {
    assert("EPERM fallback coverage skipped as root", true);
  }

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
