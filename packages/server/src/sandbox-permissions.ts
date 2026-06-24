import { chmod, lchown, lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
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
  if (st.uid !== uid || st.gid !== gid) {
    await lchown(path, uid, gid);
  }
  if (st.isSymbolicLink()) return;
  const currentMode = st.mode & 0o777;
  const desiredMode = st.isDirectory()
    ? currentMode | SANDBOX_GROUP_RWX
    : currentMode | SANDBOX_GROUP_RW | ((currentMode & 0o111) !== 0 ? SANDBOX_GROUP_X : 0);
  if (desiredMode !== currentMode) {
    await chmod(path, desiredMode);
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
