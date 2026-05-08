import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuthStorage,
  ModelRegistry,
  type Skill,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { config } from "./config.js";
import { makeLock } from "./concurrency.js";
import { discoverExtensionResources } from "./extensions-discovery.js";
import {
  getProjectSkillState,
  readSkillOverrides,
  setProjectSkillOverride,
  type SkillOverrides,
  type SkillOverrideState,
} from "./skill-overrides.js";

const MODELS_FILE = (): string => join(config.piConfigDir, "models.json");
const AUTH_FILE = (): string => join(config.piConfigDir, "auth.json");
const SETTINGS_FILE = (): string => join(config.piConfigDir, "settings.json");

/**
 * `models.json` shape we accept and emit. The SDK validates more deeply at
 * load time; this interface captures only the structure routes need to know
 * about. Treat the inner provider configs as opaque pass-through.
 */
export interface ModelsJson {
  providers: Record<string, ProviderConfig>;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  apiKeyCommand?: string | string[];
  api?: "messages" | "responses" | "completions" | string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: {
    id: string;
    name: string;
    api?: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }[];
}

export interface SettingsJson {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  skills?: string[];
  enableSkillCommands?: boolean;
  [k: string]: unknown;
}

export interface AuthEntry {
  configured: boolean;
  /** Where the credential came from — `stored` is auth.json, others come from the SDK. */
  source: string | undefined;
  label: string | undefined;
}

export interface AuthSummary {
  /** Map of provider id → presence info. NEVER includes actual key values. */
  providers: Record<string, AuthEntry>;
}

export interface ProvidersListing {
  providers: {
    provider: string;
    models: {
      id: string;
      name: string;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      input: ("text" | "image")[];
      hasAuth: boolean;
    }[];
  }[];
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(config.piConfigDir, { recursive: true });
}

/**
 * Keys we refuse to allow user-supplied input to set on any JSON-shaped
 * config blob. Without filtering, a request body like
 * `{"__proto__": {"polluted": true}}` flows through `JSON.parse` (where
 * Node decodes `__proto__` as an own data property — safe) and then
 * through a property-write somewhere downstream that *does* hit the
 * prototype chain — corrupting `Object.prototype` process-wide.
 *
 * We filter at every JSON-write boundary as defense in depth, not just
 * at the one route the original audit caught.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Recursively strip dangerous keys from a value before persisting. Used
 * by `writeModelsJson` and any other path that round-trips
 * user-supplied JSON to disk.
 */
function stripDangerousKeys<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((v: unknown) => stripDangerousKeys(v)) as unknown as T;
  }
  if (typeof input !== "object" || input === null) return input;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    Object.defineProperty(cleaned, k, {
      value: stripDangerousKeys(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cleaned as T;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await ensureConfigDir();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    // Cross-fs rename, perms, source vanished — clean up the leftover
    // tmp file before rethrowing. Without this, repeated failures would
    // leave `<path>.<uuid>.tmp` files accumulating in the config dir.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// models.json

export async function readModelsJson(): Promise<ModelsJson> {
  const data = await readJsonOr<unknown>(MODELS_FILE(), { providers: {} });
  if (typeof data !== "object" || data === null || !("providers" in data)) {
    return { providers: {} };
  }
  const r = data;
  if (typeof r.providers !== "object" || r.providers === null) {
    return { providers: {} };
  }
  return { providers: r.providers as Record<string, ProviderConfig> };
}

/**
 * Like readModelsJson but with secret-shaped fields replaced with a literal
 * sentinel. Used by the GET /config/models route so an inline `apiKey` in
 * models.json (the pi SDK accepts both inline keys and `apiKeyCommand`) is
 * never echoed back to a browser or to an operator's log shipper.
 *
 * The persisted file is unchanged — writeModelsJson takes the actual
 * shape; this redaction is purely on the read path.
 */
const SECRET_PLACEHOLDER = "***REDACTED***";
export async function readModelsJsonRedacted(): Promise<ModelsJson> {
  const raw = await readModelsJson();
  const out: Record<string, ProviderConfig> = {};
  for (const [name, provider] of Object.entries(raw.providers)) {
    out[name] = redactProviderConfig(provider);
  }
  return { providers: out };
}

function redactProviderConfig(p: ProviderConfig): ProviderConfig {
  const { apiKey, apiKeyCommand, ...rest } = p;
  const redacted: ProviderConfig = { ...rest };
  if (apiKey !== undefined) redacted.apiKey = SECRET_PLACEHOLDER;
  if (apiKeyCommand !== undefined) redacted.apiKeyCommand = SECRET_PLACEHOLDER;
  return redacted;
}

export async function writeModelsJson(data: ModelsJson): Promise<void> {
  // Round-trip secret protection: GET /config/models redacts inline
  // `apiKey` / `apiKeyCommand` to a sentinel string. If the editor
  // PUTs the body back unchanged, the literal sentinel would
  // overwrite the real secret on disk and the next request would go
  // out with `Authorization: Bearer ***REDACTED***`. Pre-merge here
  // so the sentinel means "keep the existing value" — same semantics
  // auth.json already uses for its presence-only API.
  const existing: ModelsJson = await readModelsJson().catch(() => ({ providers: {} }));
  const safe: ModelsJson = { providers: {} };
  for (const [name, provider] of Object.entries(data.providers ?? {})) {
    if (DANGEROUS_KEYS.has(name)) continue;
    const cleaned = stripDangerousKeys(provider);
    const prior = existing.providers[name];
    if (cleaned.apiKey === SECRET_PLACEHOLDER) {
      if (prior?.apiKey !== undefined) cleaned.apiKey = prior.apiKey;
      else delete cleaned.apiKey;
    }
    if (cleaned.apiKeyCommand === SECRET_PLACEHOLDER) {
      if (prior?.apiKeyCommand !== undefined) cleaned.apiKeyCommand = prior.apiKeyCommand;
      else delete cleaned.apiKeyCommand;
    }
    safe.providers[name] = cleaned;
  }
  await atomicWriteJson(MODELS_FILE(), safe);
}

// ---------------------------------------------------------------------------
// auth.json — uses the SDK's AuthStorage for locking + presence semantics.

function authStorage(): AuthStorage {
  return AuthStorage.create(AUTH_FILE());
}

/**
 * Build a fresh ModelRegistry seeded with the on-disk auth + models.json.
 * Exposed so route handlers can resolve a provider+modelId pair to a typed
 * Model<Api> WITHOUT going through pi-ai's static `getModel`, which only
 * knows built-in providers and silently returns undefined for anything
 * defined in models.json.
 */
export function liveModelRegistry(): ModelRegistry {
  return ModelRegistry.create(authStorage(), MODELS_FILE());
}

export function readAuthSummary(): AuthSummary {
  const store = authStorage();
  const providers: Record<string, AuthEntry> = {};
  // `list()` enumerates providers stored in auth.json. Augment each with the
  // typed `getAuthStatus` shape so the response surface matches what the UI
  // would render (configured + source + label, no key value).
  for (const provider of store.list()) {
    const status = store.getAuthStatus(provider);
    providers[provider] = {
      configured: status.configured,
      source: status.source,
      label: status.label,
    };
  }
  return { providers };
}

export function writeApiKey(provider: string, apiKey: string): void {
  if (provider.length === 0) throw new Error("provider name cannot be empty");
  if (apiKey.length === 0) throw new Error("api key cannot be empty");
  const store = authStorage();
  store.set(provider, { type: "api_key", key: apiKey });
}

export class AuthProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`auth provider not found: ${provider}`);
    this.name = "AuthProviderNotFoundError";
  }
}

export function removeApiKey(provider: string): void {
  const store = authStorage();
  if (!store.has(provider)) throw new AuthProviderNotFoundError(provider);
  store.remove(provider);
}

// ---------------------------------------------------------------------------
// settings.json

export async function readSettings(): Promise<SettingsJson> {
  return readJsonOr<SettingsJson>(SETTINGS_FILE(), {});
}

/**
 * Serialise all read-modify-write sequences over settings.json. Without
 * this, two concurrent PUT /config/settings requests can read the same
 * baseline and race the rename(), losing one write. Also covers the
 * snapshot+restore dance in routes/control.ts:setModel — exported so
 * that route can wrap the entire snapshot → setModel → restore sequence
 * as a single critical section. Single-process / single-tenant only.
 */
export const withSettingsLock = makeLock();

/**
 * Atomically replace settings.json with `settings`. Used by the
 * per-session model route to roll back the SDK's side effects on
 * `session.setModel(...)`. The SDK touches more keys than just
 * defaultProvider/defaultModel (defaultThinkingLevel, etc.), so a
 * key-by-key restore was leaking SDK-written values into the file
 * and resetting users' manually-curated settings to whatever the
 * SDK happened to write.
 *
 * Note: this function does NOT take `withSettingsLock`. The Promise-
 * chain lock is non-reentrant, so callers that need to write under an
 * already-held lock (e.g. `routes/control.ts:setModel` doing a
 * snapshot+restore inside its own critical section) would deadlock.
 * `atomicWriteJson` is itself crash-safe; the lock only matters for
 * read-modify-write coherency, which is owned by the caller.
 */
export async function writeSettings(settings: SettingsJson): Promise<void> {
  await atomicWriteJson(SETTINGS_FILE(), settings);
}

/**
 * Partial-merge update: shallow merge of `patch` over the existing settings.
 * Pass `null` for any key in `patch` to delete that key. Atomic write.
 *
 * Refuses prototype-pollution keys (`__proto__`, `prototype`,
 * `constructor`) — `JSON.parse` itself decodes these as own-properties
 * (which is why the simple `next[k] = v` write would actually corrupt
 * `Object.prototype`); we filter them at the boundary.
 */
export async function updateSettings(patch: Record<string, unknown>): Promise<SettingsJson> {
  return withSettingsLock(async () => {
    const current = await readSettings();
    const next: SettingsJson = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      if (v === null) {
        delete (next as Record<string, unknown>)[k];
      } else {
        // defineProperty avoids a setter-trap if the prototype chain
        // somehow contains an accessor for this key.
        Object.defineProperty(next, k, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    await atomicWriteJson(SETTINGS_FILE(), next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// providers — live from ModelRegistry. Builds a fresh registry per call so a
// PUT /config/models is reflected on the next GET /config/providers without
// needing a restart.

export async function liveProvidersListing(): Promise<ProvidersListing> {
  const store = authStorage();
  const registry = ModelRegistry.create(store, MODELS_FILE());
  const all: Model<Api>[] = registry.getAll();
  // When HIDE_BUILTIN_PROVIDERS is on, restrict to providers whose
  // name appears as a key in models.json. Built-ins (anthropic,
  // openai, etc. the SDK ships with) drop out, leaving only the
  // operator-added custom providers.
  const customOnly = config.hideBuiltinProviders
    ? new Set(Object.keys((await readModelsJson()).providers))
    : undefined;
  const grouped = new Map<string, ProvidersListing["providers"][number]>();
  for (const m of all) {
    if (customOnly !== undefined && !customOnly.has(m.provider)) continue;
    let entry = grouped.get(m.provider);
    if (entry === undefined) {
      entry = { provider: m.provider, models: [] };
      grouped.set(m.provider, entry);
    }
    entry.models.push({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      input: m.input,
      hasAuth: registry.hasConfiguredAuth(m),
    });
  }
  return { providers: Array.from(grouped.values()) };
}

// ---------------------------------------------------------------------------
// skills — discovered via the SDK; enabled-state mirrored into settings.skills.

export interface SkillSummary {
  name: string;
  description: string;
  source: "global" | "project" | "extension";
  filePath: string;
  /** Path of the extension that contributed this skill (only when source === "extension"). */
  extensionPath?: string;
  /** Whether the skill is enabled in pi's GLOBAL settings.skills list. */
  enabled: boolean;
  /**
   * Tri-state per-project override for the project the request asked
   * about. `undefined` means "inherit global." Only populated when
   * `listSkills` is called with a `projectId`.
   */
  projectOverride?: SkillOverrideState;
  /**
   * The resolved state the agent in this project would actually see —
   * `(global ∪ project.enabled) − project.disabled`. Equals `enabled`
   * when no project context is supplied.
   */
  effective: boolean;
  /** When true, this skill is invokable only via /skill:name (not auto-injected). */
  disableModelInvocation: boolean;
}

export async function listSkills(
  workspacePath: string,
  projectId?: string,
): Promise<SkillSummary[]> {
  // Pi packages can contribute skill directories or files via
  // `package.json#pi.skills`, resolved by DefaultPackageManager.
  // discoverExtensionResources returns those resolved paths so
  // loadSkills can scan them alongside the SDK's default global /
  // project dirs.
  const extResources = await discoverExtensionResources(workspacePath);
  const extensionSkillPaths = extResources.skillPaths.map((s) => s.skillPath);
  const result = loadSkills({
    cwd: workspacePath,
    agentDir: config.piConfigDir,
    skillPaths: extensionSkillPaths,
    includeDefaults: true,
  });
  const settings = await readSettings();
  // Pi's `settings.skills` is a list of override patterns, NOT a list
  // of enabled names. A skill is enabled at the global scope unless
  // an `!<name>` (or `-<name>`) pattern targets it. See the doc-comment
  // on `effectiveSkillsForProject` for the full pattern semantics.
  const globalDisabled = disabledNamesFromPatterns(settings.skills ?? []);
  const overrides = await readSkillOverrides();
  // Map registered skill paths → owning package source (e.g.
  // "pi-subagents") so each summary can attribute its origin
  // beyond the bare global / project heuristic.
  const skillPathToPackage = new Map<string, string>();
  for (const s of extResources.skillPaths) {
    skillPathToPackage.set(s.skillPath, s.packageSource);
  }
  return result.skills.map((s) =>
    skillSummary(s, workspacePath, globalDisabled, overrides, projectId, skillPathToPackage),
  );
}

function skillSummary(
  s: Skill,
  workspacePath: string,
  globalDisabled: Set<string>,
  overrides: SkillOverrides,
  projectId: string | undefined,
  skillPathToPackage: Map<string, string>,
): SkillSummary {
  // The SDK's loadSkills puts global ones under agentDir, project ones
  // under workspacePath/.pi/skills, and package-contributed ones under
  // whatever path the package's `pi.skills` manifest entry resolved
  // to (typically `~/.pi/agent/packages/<name>/skills/...`). Match
  // against the package skill-path map FIRST — those paths usually
  // don't fall under the project / global heuristics below, but
  // checking explicitly is safer.
  const packageSource = findPackageForSkill(s.baseDir, skillPathToPackage);
  const isProject = packageSource === undefined && s.baseDir.startsWith(workspacePath);
  const source: SkillSummary["source"] =
    packageSource !== undefined ? "extension" : isProject ? "project" : "global";
  const isEnabledGlobal = !globalDisabled.has(s.name);
  const projectOverride =
    projectId !== undefined ? getProjectSkillState(overrides, projectId, s.name) : undefined;
  const effective =
    projectOverride === "enabled" ? true : projectOverride === "disabled" ? false : isEnabledGlobal;
  const summary: SkillSummary = {
    name: s.name,
    description: s.description,
    source,
    filePath: s.filePath,
    enabled: isEnabledGlobal,
    effective,
    disableModelInvocation: s.disableModelInvocation,
  };
  if (packageSource !== undefined) summary.extensionPath = packageSource;
  if (projectOverride !== undefined) summary.projectOverride = projectOverride;
  return summary;
}

/**
 * Match a skill's `baseDir` against the package-skill-path map.
 * The skill's baseDir might be exactly a registered path or a
 * subdirectory of one (loadSkills recurses). Pick the longest
 * matching prefix so the closest registering package wins. Returns
 * the package source identifier ("pi-subagents", a git URL, etc.)
 * or `undefined` when the skill didn't come from any registered
 * package.
 */
function findPackageForSkill(
  baseDir: string,
  skillPathToPackage: Map<string, string>,
): string | undefined {
  let best: { path: string; pkg: string } | undefined;
  for (const [path, pkg] of skillPathToPackage) {
    if (baseDir === path || baseDir.startsWith(path + "/")) {
      if (best === undefined || path.length > best.path.length) {
        best = { path, pkg };
      }
    }
  }
  return best?.pkg;
}

/**
 * Returns the full per-project overrides map. Used by the Settings
 * UI's cascade view to render override rows for projects OTHER than
 * the active one (e.g. "this skill is disabled in 3 of 8 projects").
 */
export async function getAllSkillOverrides(): Promise<SkillOverrides> {
  return readSkillOverrides();
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill not found: ${name}`);
    this.name = "SkillNotFoundError";
  }
}

/**
 * Toggle a skill's enabled state.
 *
 * - `scope: "global"` (the default; back-compat with the original
 *   one-arg form) writes to pi's `settings.skills` — the canonical
 *   global enable/disable list.
 * - `scope: "project"` writes to the pi-forge-private overrides
 *   file at `${FORGE_DATA_DIR}/skills-overrides.json` for the
 *   given `projectId`. Tri-state: `enabled` / `disabled` /
 *   (passing `enabled: undefined` clears the override = inherit
 *   from global).
 *
 * The skill must be discoverable in the `loadSkills` result — passing
 * a name that doesn't exist throws SkillNotFoundError so route
 * handlers can return a clean 404.
 */
export async function setSkillEnabled(
  name: string,
  enabled: boolean | undefined,
  workspacePath: string,
  opts?: { scope?: "global" | "project"; projectId?: string },
): Promise<SkillSummary[]> {
  const all = await listSkills(workspacePath, opts?.projectId);
  if (!all.some((s) => s.name === name)) throw new SkillNotFoundError(name);
  const scope = opts?.scope ?? "global";
  if (scope === "project") {
    if (opts?.projectId === undefined) {
      throw new Error("setSkillEnabled: scope=project requires a projectId");
    }
    // Tri-state mapping: true → "enabled", false → "disabled",
    // undefined → clear (inherit). Project writes don't touch pi's
    // settings.skills so the global list stays stable across project
    // switches and other pi clients (TUI) keep their view.
    const state: SkillOverrideState | undefined =
      enabled === true ? "enabled" : enabled === false ? "disabled" : undefined;
    await setProjectSkillOverride(opts.projectId, name, state);
    return listSkills(workspacePath, opts.projectId);
  }
  // global scope (existing behaviour)
  if (enabled === undefined) {
    throw new Error("setSkillEnabled: scope=global requires enabled to be true or false");
  }
  // The skills array is read-modify-write against settings.skills, so
  // serialise the whole sequence under withSettingsLock — without this,
  // toggling two skills in rapid succession (the UI lets the user
  // click as fast as they want) can lose one toggle. We inline the
  // read+merge+write here rather than calling updateSettings (which
  // would deadlock — the lock is non-reentrant) and use atomicWriteJson
  // directly for the write.
  //
  // Pattern semantics: pi auto-discovers every skill on disk and
  // enables them by default. To DISABLE one we push `!<name>`. To
  // re-enable we drop any `!<name>` / `-<name>` / `+<name>` for that
  // name (absence = pi's default-on). We also drop bare-name entries
  // a prior buggy version of this file may have left on disk — pi
  // ignores them, so they're inert and just clutter the file.
  await withSettingsLock(async () => {
    const settings = await readSettings();
    const existing = settings.skills ?? [];
    const filtered = existing.filter((p) => {
      // Drop inert bare entries on every rewrite.
      if (!p.startsWith("!") && !p.startsWith("+") && !p.startsWith("-")) return false;
      // Drop any prior pattern targeting THIS skill name; we'll re-add
      // exactly the one we want below.
      if (p.slice(1) === name) return false;
      return true;
    });
    if (!enabled) filtered.push(excludePattern(name));
    const next: SettingsJson = { ...settings, skills: filtered };
    await atomicWriteJson(SETTINGS_FILE(), next);
  });
  return listSkills(workspacePath, opts?.projectId);
}

/**
 * Pi's `settings.skills` is NOT an enabled-allowlist of skill names —
 * it is a list of override PATTERNS with three prefix conventions:
 *
 *   `!<name>`  → exclude (skill won't load if pattern matches)
 *   `+<name>`  → force include (overrides any `!`)
 *   `-<name>`  → force exclude (overrides everything)
 *   bare name  → silently ignored by pi's `getOverridePatterns`
 *
 * Pi auto-discovers every skill it finds under the user/project skill
 * directories and they are ALL ENABLED BY DEFAULT. The only way to
 * disable one is to push `!<name>` (or `-<name>`) into the patterns
 * list. Writing bare names accomplishes nothing.
 *
 * Helpers below codify this so callers don't need to re-derive it.
 */
const excludePattern = (name: string): string => `!${name}`;
const forceIncludePattern = (name: string): string => `+${name}`;

/** Names that an exclude pattern (`!name` or `-name`) targets. */
function disabledNamesFromPatterns(patterns: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.startsWith("!") || p.startsWith("-")) out.add(p.slice(1));
  }
  return out;
}

/**
 * Compute the skill-pattern list a session in `projectId` should see —
 * a merge of pi's global patterns with our per-project overrides.
 *
 * Returned values are PATTERNS (`!name` / `+name`), not names. The
 * session-registry pushes them into the SettingsManager so pi's
 * package-manager applies them when discovering skills.
 *
 * Resolution rules:
 *   - Start with whatever patterns pi already has at the global scope
 *     (these come from prior `setSkillEnabled(scope:"global")` writes).
 *   - For every skill the project marked `disable`, ensure `!<name>`
 *     is in the list — even if no global exclude exists.
 *   - For every skill the project marked `enable`, push `+<name>` so
 *     it force-includes in this project's session even if a global
 *     `!<name>` would otherwise hide it.
 */
export async function effectiveSkillsForProject(projectId: string): Promise<string[]> {
  const settings = await readSettings();
  const overrides: SkillOverrides = await readSkillOverrides();
  // Filter to only valid override patterns; drop any inert bare entries
  // a prior buggy version of this code might have left on disk.
  const globalPatterns = (settings.skills ?? []).filter(
    (p) => p.startsWith("!") || p.startsWith("+") || p.startsWith("-"),
  );
  const result = new Set<string>(globalPatterns);
  const entry = overrides.projects[projectId];
  if (entry !== undefined) {
    for (const name of entry.disable) result.add(excludePattern(name));
    for (const name of entry.enable) result.add(forceIncludePattern(name));
  }
  return Array.from(result);
}
