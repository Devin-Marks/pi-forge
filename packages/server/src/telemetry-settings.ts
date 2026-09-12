import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";

const TELEMETRY_SETTINGS_FILE = (): string => join(config.forgeDataDir, "telemetry-settings.json");

export interface TelemetrySettings {
  captureContent: boolean;
}

const lock = makeLock();
let captureContent = loadInitialCaptureContent();

function normalizeCaptureContent(input: unknown): boolean | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const raw = (input as { captureContent?: unknown }).captureContent;
  return typeof raw === "boolean" ? raw : undefined;
}

function loadInitialCaptureContent(): boolean {
  const path = TELEMETRY_SETTINGS_FILE();
  if (!existsSync(path)) return config.telemetry.captureContent;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return normalizeCaptureContent(parsed) ?? config.telemetry.captureContent;
  } catch {
    return config.telemetry.captureContent;
  }
}

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

export function isTelemetryContentCaptureEnabled(): boolean {
  return captureContent;
}

export async function readTelemetrySettings(): Promise<TelemetrySettings> {
  return lock(async () => {
    try {
      const raw = await readFile(TELEMETRY_SETTINGS_FILE(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      captureContent = normalizeCaptureContent(parsed) ?? config.telemetry.captureContent;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      captureContent = config.telemetry.captureContent;
    }
    return { captureContent };
  });
}

export async function writeTelemetrySettings(
  settings: TelemetrySettings,
): Promise<TelemetrySettings> {
  const safe: TelemetrySettings = { captureContent: settings.captureContent };
  await lock(async () => {
    await atomicWriteJson(TELEMETRY_SETTINGS_FILE(), safe);
    captureContent = safe.captureContent;
  });
  return safe;
}
