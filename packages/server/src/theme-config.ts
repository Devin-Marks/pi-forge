import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";

export const THEME_CONFIG_FILE = (): string => join(config.forgeDataDir, "theme.json");

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const THEME_COLOR_KEYS = [
  "appBackground",
  "panelBackground",
  "userBubbleBackground",
  "assistantBubbleBackground",
  "primaryText",
  "secondaryText",
  "mutedText",
  "highlightBackground",
  "highlightText",
  "selectionBackground",
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

export type ThemeColors = Record<ThemeColorKey, string>;

export interface ServerThemeConfig {
  enabled: boolean;
  colors: ThemeColors;
}

export const DEFAULT_THEME_COLORS: ThemeColors = {
  appBackground: "#0a0a0a",
  panelBackground: "#171717",
  userBubbleBackground: "#262626",
  assistantBubbleBackground: "#171717",
  primaryText: "#f5f5f5",
  secondaryText: "#d4d4d4",
  mutedText: "#a3a3a3",
  highlightBackground: "#facc15",
  highlightText: "#111827",
  selectionBackground: "#525252",
};

export const DEFAULT_THEME_CONFIG: ServerThemeConfig = {
  enabled: false,
  colors: DEFAULT_THEME_COLORS,
};

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

function isThemeColorKey(k: string): k is ThemeColorKey {
  return (THEME_COLOR_KEYS as readonly string[]).includes(k);
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : fallback;
}

function normalizeThemeConfig(input: unknown): ServerThemeConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return DEFAULT_THEME_CONFIG;
  }
  const obj = input as { enabled?: unknown; colors?: unknown };
  const colorsInput =
    typeof obj.colors === "object" && obj.colors !== null && !Array.isArray(obj.colors)
      ? (obj.colors as Record<string, unknown>)
      : {};
  const colors = { ...DEFAULT_THEME_COLORS };
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = normalizeColor(colorsInput[key], DEFAULT_THEME_COLORS[key]);
  }
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : false,
    colors,
  };
}

export function validateThemeConfig(input: ServerThemeConfig): ServerThemeConfig {
  if (typeof input.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  const colorsInput = input.colors;
  if (typeof colorsInput !== "object" || colorsInput === null || Array.isArray(colorsInput)) {
    throw new Error("colors must be an object");
  }
  const colors = { ...DEFAULT_THEME_COLORS };
  for (const [key, value] of Object.entries(colorsInput)) {
    if (!isThemeColorKey(key)) continue;
    if (!HEX_COLOR_RE.test(value)) {
      throw new Error(`${key} must be a 6-digit hex color like #0a0a0a`);
    }
    colors[key] = value;
  }
  return { enabled: input.enabled, colors };
}

export async function readThemeConfig(): Promise<ServerThemeConfig> {
  return lock(async () => {
    try {
      const raw = await readFile(THEME_CONFIG_FILE(), "utf8");
      return normalizeThemeConfig(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_THEME_CONFIG;
      throw err;
    }
  });
}

export async function writeThemeConfig(input: ServerThemeConfig): Promise<ServerThemeConfig> {
  const safe = validateThemeConfig(input);
  await lock(async () => atomicWriteJson(THEME_CONFIG_FILE(), safe));
  return safe;
}

export async function resetThemeConfig(): Promise<ServerThemeConfig> {
  await lock(async () => atomicWriteJson(THEME_CONFIG_FILE(), DEFAULT_THEME_CONFIG));
  return DEFAULT_THEME_CONFIG;
}
