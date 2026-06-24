import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "./config.js";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const LOGO_PREFIX = "/cache/logos/";

const CONTENT_TYPE_EXTENSIONS: readonly [RegExp, string][] = [
  [/^image\/svg\+xml\b/i, ".svg"],
  [/^image\/png\b/i, ".png"],
  [/^image\/jpeg\b/i, ".jpg"],
  [/^image\/gif\b/i, ".gif"],
  [/^image\/webp\b/i, ".webp"],
  [/^image\/avif\b/i, ".avif"],
];

const PATH_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);

type LogoKey = "auth" | "appDark" | "appLight";

export interface LogoUrlState {
  authLogoUrl: string | undefined;
  appLogoDarkUrl: string | undefined;
  appLogoLightUrl: string | undefined;
}

let cachedLogoState: LogoUrlState = {
  authLogoUrl: undefined,
  appLogoDarkUrl: undefined,
  appLogoLightUrl: undefined,
};

export function logoCacheDir(): string {
  return join(config.forgeDataDir, "cache", "logos");
}

export function logoUrls(): LogoUrlState {
  if (config.logoUrlMode === "direct") {
    return {
      authLogoUrl: config.authLogoUrl,
      appLogoDarkUrl: config.appLogoDarkUrl,
      appLogoLightUrl: config.appLogoLightUrl,
    };
  }
  return cachedLogoState;
}

export async function initializeLogoCache(log: {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}): Promise<void> {
  if (config.logoUrlMode === "direct") {
    log.info("logo URL mode is direct; skipping server-side logo cache refresh");
    return;
  }
  await mkdir(logoCacheDir(), { recursive: true });
  const entries: [LogoKey, string | undefined][] = [
    ["auth", config.authLogoUrl],
    ["appDark", config.appLogoDarkUrl],
    ["appLight", config.appLogoLightUrl],
  ];
  const resolved = await Promise.all(
    entries.map(async ([key, sourceUrl]) => [key, await cacheLogo(key, sourceUrl, log)] as const),
  );
  cachedLogoState = {
    authLogoUrl: resolved.find(([key]) => key === "auth")?.[1],
    appLogoDarkUrl: resolved.find(([key]) => key === "appDark")?.[1],
    appLogoLightUrl: resolved.find(([key]) => key === "appLight")?.[1],
  };
}

async function cacheLogo(
  key: LogoKey,
  sourceUrl: string | undefined,
  log: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void },
): Promise<string | undefined> {
  if (sourceUrl === undefined) return undefined;
  try {
    const fetched = await fetchLogo(sourceUrl);
    const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16);
    const filename = `${key}-${hash}${fetched.extension}`;
    const destination = join(logoCacheDir(), filename);
    const tmp = `${destination}.${process.pid}.tmp`;
    await writeFile(tmp, fetched.bytes, { mode: 0o644 });
    await rename(tmp, destination);
    log.info({ key, sourceUrl, bytes: fetched.bytes.byteLength, file: destination }, "cached logo");
    return `${LOGO_PREFIX}${filename}`;
  } catch (err) {
    log.warn({ key, sourceUrl, err }, "logo cache refresh failed; using built-in fallback");
    return undefined;
  }
}

async function fetchLogo(sourceUrl: string): Promise<{ bytes: Buffer; extension: string }> {
  let current = new URL(sourceUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertSafeLogoUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, { redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location.length === 0) {
        throw new Error(`redirect without location from ${current.origin}`);
      }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const extension = extensionFor(contentType, current);
    if (extension === undefined) {
      throw new Error(`unsupported logo content-type: ${contentType || "unknown"}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_LOGO_BYTES) {
      throw new Error(`logo exceeds ${MAX_LOGO_BYTES} bytes`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_LOGO_BYTES) {
      throw new Error(`logo exceeds ${MAX_LOGO_BYTES} bytes`);
    }
    return { bytes, extension };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

function extensionFor(contentType: string, url: URL): string | undefined {
  for (const [pattern, extension] of CONTENT_TYPE_EXTENSIONS) {
    if (pattern.test(contentType)) return extension;
  }
  const ext = extnameFromPath(url.pathname);
  return PATH_EXTENSIONS.has(ext) ? ext : undefined;
}

function extnameFromPath(pathname: string): string {
  const name = basename(pathname).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot) === ".jpeg" ? ".jpg" : name.slice(dot);
}

async function assertSafeLogoUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported logo scheme ${url.protocol}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("logo URL must not include credentials");
  }
  if (config.isTest) return;
  const addrs = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("logo hostname did not resolve");
  for (const addr of addrs) {
    if (isPrivateAddress(addr.address)) {
      throw new Error(`logo hostname resolves to disallowed private address ${addr.address}`);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address.toLowerCase() === "localhost") return true;
  if (address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) {
    return true;
  }
  const parts = address.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export async function clearCachedLogoStateForTests(): Promise<void> {
  cachedLogoState = {
    authLogoUrl: undefined,
    appLogoDarkUrl: undefined,
    appLogoLightUrl: undefined,
  };
  await rm(logoCacheDir(), { recursive: true, force: true });
}

export const LOGO_CACHE_PREFIX = LOGO_PREFIX;
