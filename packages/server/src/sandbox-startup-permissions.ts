import { lchown, lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { config } from "./config.js";

const PI_CONFIG_RESOURCE_DIRS = ["skills", "npm", "git", "extensions", "prompts", "themes"];

function isSameOrInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function describeAllowedSandboxChownPaths(): string {
  const resourcePaths = PI_CONFIG_RESOURCE_DIRS.map((dir) => resolve(config.piConfigDir, dir));
  return [config.workspacePath, config.agentToolSandbox.home, ...resourcePaths].join(", ");
}

function assertAllowedSandboxChownPath(path: string): void {
  const abs = resolve(path);
  const allowedRoots = [
    config.workspacePath,
    config.agentToolSandbox.home,
    ...PI_CONFIG_RESOURCE_DIRS.map((dir) => resolve(config.piConfigDir, dir)),
  ];
  if (allowedRoots.some((root) => isSameOrInside(root, abs))) return;
  throw new Error(
    `sandbox startup chown path ${abs} is outside allowed roots. ` +
      `Allowed roots: ${describeAllowedSandboxChownPaths()}`,
  );
}

async function chownRecursiveNoFollow(path: string, uid: number, gid: number): Promise<void> {
  const st = await lstat(path);
  if (st.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) {
      await chownRecursiveNoFollow(resolve(path, entry), uid, gid);
    }
  }
  if (st.uid === uid && st.gid === gid) return;
  await lchown(path, uid, gid);
}

export async function applySandboxStartupChowns(): Promise<void> {
  const paths = config.agentToolSandbox.chownPaths;
  if (paths.length === 0) return;
  if (!config.agentToolSandbox.enabled) {
    console.warn(
      "[sandbox-startup] AGENT_TOOL_SANDBOX_CHOWN_PATHS is set but sandbox mode is disabled; skipping chown",
    );
    return;
  }

  const uid = config.agentToolSandbox.uid!;
  const gid = config.agentToolSandbox.gid!;
  for (const path of paths) {
    const abs = resolve(path);
    assertAllowedSandboxChownPath(abs);
    await chownRecursiveNoFollow(abs, uid, gid);
    console.log(`[sandbox-startup] chowned ${abs} to ${uid}:${gid}`);
  }
}

export const sandboxStartupPermissionsInternals = Object.freeze({
  PI_CONFIG_RESOURCE_DIRS,
  isSameOrInside,
  assertAllowedSandboxChownPath,
});
