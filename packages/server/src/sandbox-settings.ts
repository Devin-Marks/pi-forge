import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";

const SANDBOX_SETTINGS_FILE = (): string => join(config.forgeDataDir, "sandbox-settings.json");
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 100;
const MAX_ENV_VALUE_BYTES = 16 * 1024;

export interface SandboxSettings {
  toolEnv: Record<string, string>;
}

const lock = makeLock();

async function ensureDataDir(): Promise<void> {
  await mkdir(config.forgeDataDir, { recursive: true });
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await ensureDataDir();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function normalizeToolEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!ENV_NAME_RE.test(name)) continue;
    if (typeof value !== "string") continue;
    if (Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES) continue;
    out[name] = value;
    if (Object.keys(out).length >= MAX_ENV_VARS) break;
  }
  return out;
}

export function validateSandboxToolEnv(input: Record<string, string>): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_ENV_VARS) {
    throw new Error(`too many environment variables (max ${MAX_ENV_VARS})`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES) {
      throw new Error(`environment variable ${name} exceeds ${MAX_ENV_VALUE_BYTES} bytes`);
    }
    out[name] = value;
  }
  return out;
}

export async function readSandboxSettings(): Promise<SandboxSettings> {
  return lock(async () => {
    try {
      const raw = await readFile(SANDBOX_SETTINGS_FILE(), "utf8");
      const parsed = JSON.parse(raw) as { toolEnv?: unknown };
      return { toolEnv: normalizeToolEnv(parsed.toolEnv) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { toolEnv: {} };
      throw err;
    }
  });
}

export async function writeSandboxSettings(settings: SandboxSettings): Promise<SandboxSettings> {
  const safe: SandboxSettings = { toolEnv: validateSandboxToolEnv(settings.toolEnv) };
  await lock(async () => atomicWriteJson(SANDBOX_SETTINGS_FILE(), safe));
  return safe;
}

export function mergeToolEnv(
  base: Record<string, string>,
  toolEnv: Record<string, string>,
): Record<string, string> {
  return { ...base, ...toolEnv };
}
