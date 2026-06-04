/**
 * Surface pi PACKAGE contributions (extension-registered tools +
 * skills) to the pi-forge layer.
 *
 * Background: pi keeps two separate concepts. **Packages** are the
 * install unit (npm or git, persisted in `settings.json#packages[]`,
 * managed by `DefaultPackageManager`). A package can contribute any
 * of `extensions`, `skills`, `prompts`, `themes` declared in its
 * `package.json#pi` manifest. **Extensions** are the JS/TS modules
 * that programmatically register tools at session start. So a single
 * package (e.g. pi-subagents) can register tools via its extension
 * entry AND ship a `skills/` dir AND ship `prompts/` — all flowing
 * through the same package install.
 *
 * Pi's own `DefaultResourceLoader.reload()` does:
 *
 *   const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
 *   const resolved = await packageManager.resolve();
 *   // resolved.extensions, resolved.skills, etc. are ResolvedResource[]
 *   // with .path, .enabled, .metadata.source
 *
 * We mirror that. The PackageManager handles every install location —
 * `~/.pi/agent/packages/<name>/` for npm-installed-via-pi, project
 * `.pi/packages/`, plus any directory installs the user did manually.
 * No hardcoded path scan.
 *
 * After the package manager hands us the enabled paths:
 *   - Extension paths get passed as `configuredPaths` to
 *     `discoverAndLoadExtensions(...)` so we can enumerate the tool
 *     names each extension registers.
 *   - Skill paths feed into `loadSkills(skillPaths: [...])` for
 *     enumeration in Settings → Skills.
 *
 * The `metadata.source` field on each ResolvedResource is the
 * user-visible package name ("pi-subagents", "git+https://…"). We
 * surface it as `packageSource` so the Settings UI can group tools
 * + skills by package instead of by extension entry path.
 */
import {
  discoverAndLoadExtensions,
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";

function isDisabledInSandboxPackageSource(source: string): boolean {
  return config.agentToolSandbox.enabled && source.includes("pi-subagents");
}

export interface ExtensionToolInfo {
  /** Name as the agent sees it (what `pi.registerTool({ name })` set). */
  name: string;
  /**
   * The package that contributed this tool (e.g. "pi-subagents").
   * Sourced from `ResolvedResource.metadata.source`. Always defined —
   * if the package manager couldn't attribute the source the entry is
   * skipped (we never want to render an unattributed row in Settings).
   */
  packageSource: string;
  /** Optional human-readable description from the tool definition. */
  description?: string;
}

export interface ExtensionSkillSource {
  /** Package that contributed this skill directory / file. */
  packageSource: string;
  /** Path pi's `loadSkills` should scan (file or directory). */
  skillPath: string;
}

export interface ExtensionResources {
  tools: ExtensionToolInfo[];
  skillPaths: ExtensionSkillSource[];
  /** Errors from extension load — surfaced for diagnostics; non-fatal. */
  errors: { path: string; error: string }[];
}

/**
 * Resolve package-contributed resources visible to a session in `cwd`.
 *
 * Used by:
 *   - `session-registry.buildToolsAllowlist` to union package-extension
 *     tool names into the allowlist passed to `createAgentSession`
 *   - `routes/config.ts` `GET /config/tools` to list package-contributed
 *     tools in the Settings → Tools tab (grouped by package)
 *   - `config-manager.listSkills` to feed package skill paths into
 *     `loadSkills` so they show up in Settings → Skills
 *
 * Failures inside individual packages or extensions surface as
 * `errors[]` rather than throwing. A single broken package must not
 * block session creation or settings rendering.
 */
export async function discoverExtensionResources(cwd: string): Promise<ExtensionResources> {
  const errors: { path: string; error: string }[] = [];
  let extensionPathToPackage: Map<string, string>;
  let skillEntries: ExtensionSkillSource[];
  try {
    const settingsManager = SettingsManager.create(cwd, config.piConfigDir);
    // Some SDK paths reload settings on construction; defensively
    // call reload here so we read the on-disk packages list fresh
    // (matches DefaultResourceLoader.reload() ordering).
    await settingsManager.reload?.();
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir: config.piConfigDir,
      settingsManager,
    });
    const resolved = await packageManager.resolve();
    // Filter to enabled paths AND keep their source attribution. A
    // resource without a metadata.source we can't attribute is
    // dropped — better silently absent than rendered as "unknown".
    extensionPathToPackage = new Map();
    for (const r of resolved.extensions) {
      if (!r.enabled) continue;
      const src = r.metadata.source;
      if (typeof src !== "string" || src.length === 0) continue;
      if (isDisabledInSandboxPackageSource(src)) continue;
      extensionPathToPackage.set(r.path, src);
    }
    skillEntries = [];
    for (const r of resolved.skills) {
      if (!r.enabled) continue;
      // Only forward PACKAGE-origin skills. The PackageManager also
      // surfaces auto-discovered top-level skills (the bare global
      // skill dir, project .pi/skills, etc.) with `origin:
      // "top-level"` — those are already loaded by the
      // `includeDefaults: true` path in `loadSkills`, so passing
      // them through too would double-count every default skill.
      if (r.metadata.origin !== "package") continue;
      const src = r.metadata.source;
      if (typeof src !== "string" || src.length === 0) continue;
      if (isDisabledInSandboxPackageSource(src)) continue;
      skillEntries.push({ packageSource: src, skillPath: r.path });
    }
  } catch (err) {
    errors.push({
      path: "<package-manager>",
      error: err instanceof Error ? err.message : String(err),
    });
    return { tools: [], skillPaths: [], errors };
  }

  // Now load each extension to enumerate its registered tools.
  // discoverAndLoadExtensions accepts our resolved extension paths
  // via the third (configuredPaths) arg — it'll still also scan the
  // legacy `cwd/.pi/extensions/` and `agentDir/extensions/` dirs,
  // which is fine for backward compat with hand-dropped extensions.
  const tools: ExtensionToolInfo[] = [];
  if (extensionPathToPackage.size === 0) {
    return { tools, skillPaths: skillEntries, errors };
  }
  let loaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>>;
  try {
    loaded = await discoverAndLoadExtensions(
      Array.from(extensionPathToPackage.keys()),
      cwd,
      config.piConfigDir,
    );
  } catch (err) {
    errors.push({
      path: "<discoverAndLoadExtensions>",
      error: err instanceof Error ? err.message : String(err),
    });
    return { tools, skillPaths: skillEntries, errors };
  }
  for (const e of loaded.errors) {
    errors.push({ path: e.path, error: e.error });
  }
  for (const ext of loaded.extensions) {
    const pkgSource =
      extensionPathToPackage.get(ext.path) ?? extensionPathToPackage.get(ext.resolvedPath);
    if (pkgSource === undefined) continue; // Not from a package we resolved (legacy dir scan); skip.
    for (const [, registered] of ext.tools) {
      const def = registered.definition;
      const info: ExtensionToolInfo = { name: def.name, packageSource: pkgSource };
      if (typeof def.description === "string" && def.description.length > 0) {
        info.description = def.description;
      }
      tools.push(info);
    }
  }
  return { tools, skillPaths: skillEntries, errors };
}
