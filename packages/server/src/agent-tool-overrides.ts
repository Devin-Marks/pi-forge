import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createForgeBashOperations } from "./agent-bash-operations.js";
import { assertAgentToolPathAllowed, resolveAgentToolPath } from "./agent-tool-policy.js";
import {
  applySandboxParentChainHandoff,
  applySandboxPathHandoff,
  applySandboxTreeHandoff,
} from "./sandbox-permissions.js";

function guard(workspacePath: string, absolutePath: string): string {
  return resolveAgentToolPath(workspacePath, absolutePath);
}

export function createSandboxedToolDefinitions(
  workspacePath: string,
  toolEnv: Record<string, string> = {},
): ToolDefinition[] {
  const readOps: ReadOperations = {
    readFile: async (absolutePath) => readFile(guard(workspacePath, absolutePath)),
    access: async (absolutePath) => access(guard(workspacePath, absolutePath)),
    detectImageMimeType: async () => undefined,
  };

  const grepOps: GrepOperations = {
    isDirectory: async (absolutePath) =>
      (await stat(guard(workspacePath, absolutePath))).isDirectory(),
    readFile: async (absolutePath) => readFile(guard(workspacePath, absolutePath), "utf8"),
  };

  const findOps: FindOperations = {
    exists: async (absolutePath) => {
      try {
        await access(guard(workspacePath, absolutePath));
        return true;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return false;
        throw err;
      }
    },
    glob: async (pattern, cwd, options) => {
      const safeCwd = guard(workspacePath, cwd);
      const results = await glob(pattern, {
        cwd: safeCwd,
        absolute: true,
        nodir: false,
        dot: true,
        ignore: options.ignore,
      });
      const allowed: string[] = [];
      for (const result of results) {
        assertAgentToolPathAllowed(workspacePath, result);
        allowed.push(result);
        if (allowed.length >= options.limit) break;
      }
      return allowed;
    },
  };

  const lsOps: LsOperations = {
    exists: async (absolutePath) => {
      try {
        await access(guard(workspacePath, absolutePath));
        return true;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return false;
        throw err;
      }
    },
    stat: async (absolutePath) => stat(guard(workspacePath, absolutePath)),
    readdir: async (absolutePath) => readdir(guard(workspacePath, absolutePath)),
  };

  const editOps: EditOperations = {
    readFile: async (absolutePath) => readFile(guard(workspacePath, absolutePath)),
    writeFile: async (absolutePath, content) => {
      const safePath = guard(workspacePath, absolutePath);
      await applySandboxParentChainHandoff(workspacePath, safePath);
      await writeFile(safePath, content);
      await applySandboxPathHandoff(safePath);
    },
    access: async (absolutePath) => access(guard(workspacePath, absolutePath)),
  };

  const writeOps: WriteOperations = {
    writeFile: async (absolutePath, content) => {
      const safePath = guard(workspacePath, absolutePath);
      await applySandboxParentChainHandoff(workspacePath, safePath);
      await writeFile(safePath, content);
      await applySandboxPathHandoff(safePath);
    },
    mkdir: async (dir) => {
      const safeDir = guard(workspacePath, dir);
      await applySandboxParentChainHandoff(workspacePath, safeDir);
      await mkdir(safeDir, { recursive: true });
      await applySandboxTreeHandoff(safeDir);
    },
  };

  return [
    createReadToolDefinition(workspacePath, { operations: readOps }),
    createGrepToolDefinition(workspacePath, { operations: grepOps }),
    createFindToolDefinition(workspacePath, { operations: findOps }),
    createLsToolDefinition(workspacePath, { operations: lsOps }),
    createEditToolDefinition(workspacePath, { operations: editOps }),
    createWriteToolDefinition(workspacePath, { operations: writeOps }),
    createBashToolDefinition(workspacePath, {
      operations: createForgeBashOperations(workspacePath, toolEnv),
    }),
  ] as unknown as ToolDefinition[];
}

export function resolveSandboxedAgentPath(workspacePath: string, requestedPath: string): string {
  return guard(workspacePath, join(workspacePath, requestedPath));
}
