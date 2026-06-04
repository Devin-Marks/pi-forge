import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep, relative } from "node:path";
import { config } from "./config.js";

const PROTECTED_PI_CONFIG_FILES = new Set(["auth.json", "models.json", "settings.json"]);
const HOME_SECRET_DIRS = new Set([".ssh", ".aws", ".kube", ".gnupg"]);
const DENIED_PREFIXES = ["/proc", "/etc", "/run/secrets", "/var/run/secrets"];

export class AgentToolPathDeniedError extends Error {
  constructor(message: string) {
    super(`agent_tool_path_denied: ${message}`);
    this.name = "AgentToolPathDeniedError";
  }
}

function pathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathExistingOrParent(abs: string): string {
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return realpathSync.native(cur);
}

function firstSegment(rel: string): string {
  return rel.split(/[\\/]/)[0] ?? "";
}

function piConfigRelativePath(
  baseResolved: string,
  resolvedReal: string,
  piConfigReal: string,
): string | undefined {
  const candidate = pathWithin(baseResolved, piConfigReal) ? baseResolved : resolvedReal;
  const rel = relative(piConfigReal, candidate).split(sep).join("/");
  if (rel === "" || rel.startsWith("../")) return undefined;
  return rel;
}

function assertPiConfigPathAllowed(
  baseResolved: string,
  resolvedReal: string,
  piConfigReal: string,
): boolean {
  if (!pathWithin(baseResolved, piConfigReal) && !pathWithin(resolvedReal, piConfigReal)) {
    return false;
  }

  for (const candidate of [baseResolved, resolvedReal]) {
    if (!pathWithin(candidate, piConfigReal)) continue;
    const rel = relative(piConfigReal, candidate).split(sep).join("/");
    if (!rel.includes("/") && PROTECTED_PI_CONFIG_FILES.has(rel)) {
      throw new AgentToolPathDeniedError(`${rel} is protected pi config`);
    }
  }
  return true;
}

function denyIfSensitiveAbsolute(abs: string, workspaceReal: string, piConfigReal: string): void {
  for (const prefix of DENIED_PREFIXES) {
    if (abs === prefix || abs.startsWith(`${prefix}/`)) {
      throw new AgentToolPathDeniedError(`${abs} is not available to model tools`);
    }
  }
  if (pathWithin(abs, config.forgeDataDir)) {
    throw new AgentToolPathDeniedError(`${abs} is inside FORGE_DATA_DIR`);
  }
  const home = process.env.HOME;
  if (home !== undefined && home !== "") {
    const homeAbs = resolve(home);
    if (pathWithin(abs, homeAbs)) {
      const seg = firstSegment(relative(homeAbs, abs));
      if (
        HOME_SECRET_DIRS.has(seg) &&
        !pathWithin(abs, workspaceReal) &&
        !pathWithin(abs, piConfigReal)
      ) {
        throw new AgentToolPathDeniedError(`${abs} is inside a home secret directory`);
      }
    }
  }
}

export function resolveAgentToolPath(workspacePath: string, requestedPath: string): string {
  if (requestedPath.trim() === "") {
    throw new AgentToolPathDeniedError("empty path is not allowed");
  }
  const workspaceReal = realpathExistingOrParent(resolve(config.workspacePath));
  const piConfigReal = realpathExistingOrParent(resolve(config.piConfigDir));
  const forgeDataReal = realpathExistingOrParent(resolve(config.forgeDataDir));
  const baseResolved = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspacePath, requestedPath);
  const resolvedReal = realpathExistingOrParent(baseResolved);

  denyIfSensitiveAbsolute(baseResolved, workspaceReal, piConfigReal);
  denyIfSensitiveAbsolute(resolvedReal, workspaceReal, piConfigReal);
  if (pathWithin(baseResolved, forgeDataReal) || pathWithin(resolvedReal, forgeDataReal)) {
    throw new AgentToolPathDeniedError(`${baseResolved} is inside FORGE_DATA_DIR`);
  }

  const isPiConfigPath = assertPiConfigPathAllowed(baseResolved, resolvedReal, piConfigReal);

  if (pathWithin(resolvedReal, workspaceReal)) return baseResolved;

  if (isPiConfigPath) {
    const rel = piConfigRelativePath(baseResolved, resolvedReal, piConfigReal);
    if (rel === undefined) {
      throw new AgentToolPathDeniedError(`${baseResolved} is outside PI_CONFIG_DIR`);
    }
    return baseResolved;
  }

  throw new AgentToolPathDeniedError(`${baseResolved} is outside allowed roots`);
}

export function assertAgentToolPathAllowed(workspacePath: string, requestedPath: string): void {
  resolveAgentToolPath(workspacePath, requestedPath);
}
