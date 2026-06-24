import { chmod, lchown, lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "./config.js";

const SANDBOX_GROUP_RW = 0o060;
const SANDBOX_GROUP_RWX = 0o070;
const SANDBOX_GROUP_X = 0o010;

export function sandboxPermissionsEnabled(): boolean {
  return config.agentToolSandbox.enabled;
}

export function sandboxSharedGid(): number {
  return typeof process.getgid === "function" ? process.getgid() : 0;
}

export function sandboxHandoffDescription(): string {
  return `${config.agentToolSandbox.uid}:${sandboxSharedGid()}`;
}

export async function applySandboxPathHandoff(path: string): Promise<void> {
  if (!sandboxPermissionsEnabled()) return;
  const st = await lstat(path);
  const uid = config.agentToolSandbox.uid!;
  const gid = sandboxSharedGid();
  if (st.isSymbolicLink()) {
    if (st.uid !== uid || st.gid !== gid) {
      await lchown(path, uid, gid);
    }
    return;
  }

  const currentMode = st.mode & 0o777;
  const desiredMode = st.isDirectory()
    ? currentMode | SANDBOX_GROUP_RWX
    : currentMode | SANDBOX_GROUP_RW | ((currentMode & 0o111) !== 0 ? SANDBOX_GROUP_X : 0);

  // Sandbox containers keep CHOWN but intentionally do not need FOWNER or
  // DAC_OVERRIDE. On Linux, UID 0 without FOWNER cannot chmod a path after
  // it has been chowned to the tool UID. Temporarily make the running server
  // identity the owner, apply mode bits, then hand ownership to the tool UID.
  const serverUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (serverUid !== undefined && st.uid !== serverUid) {
    await lchown(path, serverUid, gid);
  } else if (st.gid !== gid) {
    await lchown(path, st.uid, gid);
  }

  if (desiredMode !== currentMode) {
    await chmod(path, desiredMode);
  }

  const afterModeOwner = await lstat(path);
  if (afterModeOwner.uid !== uid || afterModeOwner.gid !== gid) {
    await lchown(path, uid, gid);
  }
}

export async function applySandboxTreeHandoff(path: string): Promise<void> {
  if (!sandboxPermissionsEnabled()) return;
  const st = await lstat(path);
  if (st.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) {
      await applySandboxTreeHandoff(resolve(path, entry));
    }
  }
  await applySandboxPathHandoff(path);
}

export async function applySandboxDirectoryChainHandoff(root: string, dir: string): Promise<void> {
  if (!sandboxPermissionsEnabled()) return;
  const resolvedRoot = resolve(root);
  const resolvedDir = resolve(dir);
  const rel = relative(resolvedRoot, resolvedDir);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
    await applySandboxPathHandoff(resolvedDir);
    return;
  }
  const parts = rel.split(sep).filter(Boolean);
  let current = resolvedRoot;
  await applyExistingSandboxPathHandoff(current);
  for (const part of parts) {
    current = join(current, part);
    await applyExistingSandboxPathHandoff(current);
  }
}

async function applyExistingSandboxPathHandoff(path: string): Promise<void> {
  await applySandboxPathHandoff(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

export async function applySandboxParentChainHandoff(root: string, path: string): Promise<void> {
  await applySandboxDirectoryChainHandoff(root, dirname(path));
}
