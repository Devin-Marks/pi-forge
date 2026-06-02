import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSession } from "./session-registry.js";

export type ExternalSubagentState = "queued" | "running" | "complete" | "failed" | "paused";

export interface ExternalSubagentStatus {
  runId: string;
  rootRunId: string;
  state: ExternalSubagentState;
  isExternalLive: boolean;
  statusPath: string;
  resultPath?: string;
  parentSessionId?: string;
  sessionFile?: string;
}

interface AsyncStatusFile {
  runId?: string;
  sessionId?: string;
  state?: ExternalSubagentState;
  sessionFile?: string;
  steps?: { sessionFile?: string; status?: string }[];
}

interface AsyncResultFile {
  id?: string;
  runId?: string;
  agent?: string;
  success?: boolean;
  summary?: string;
  state?: string;
  sessionId?: string;
  sessionFile?: string;
  results?: {
    agent?: string;
    output?: string;
    success?: boolean;
    error?: string;
    sessionFile?: string;
  }[];
}

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // fall through
  }
  const homedir = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
  return "shared";
}

export const SUBAGENTS_TEMP_ROOT = join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const SUBAGENTS_RESULTS_DIR = join(SUBAGENTS_TEMP_ROOT, "async-subagent-results");
export const SUBAGENTS_ASYNC_DIR = join(SUBAGENTS_TEMP_ROOT, "async-subagent-runs");

const TERMINAL_STATES = new Set<ExternalSubagentState>(["complete", "failed", "paused"]);
const ACTIVE_STATES = new Set<ExternalSubagentState>(["queued", "running"]);
const deliveredCompletionKeys = new Set<string>();
let watcherStarted = false;
let asyncWatcher: FSWatcher | undefined;
let resultsWatcher: FSWatcher | undefined;
let scanTimer: NodeJS.Timeout | undefined;

function rootRunId(runId: string | undefined): string | undefined {
  return runId?.split(/[\\/]/, 1)[0];
}

function isExternalState(value: unknown): value is ExternalSubagentState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "paused"
  );
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readStatusByRoot(root: string): Promise<ExternalSubagentStatus | undefined> {
  const statusPath = join(SUBAGENTS_ASYNC_DIR, root, "status.json");
  const status = await readJson<AsyncStatusFile>(statusPath);
  if (!isExternalState(status?.state)) return undefined;
  const resultPath = join(SUBAGENTS_RESULTS_DIR, `${root}.json`);
  const out: ExternalSubagentStatus = {
    runId: status.runId ?? root,
    rootRunId: root,
    state: status.state,
    isExternalLive: ACTIVE_STATES.has(status.state),
    statusPath,
  };
  if (existsSync(resultPath)) out.resultPath = resultPath;
  if (typeof status.sessionId === "string") out.parentSessionId = status.sessionId;
  if (typeof status.sessionFile === "string") out.sessionFile = status.sessionFile;
  return out;
}

function statusMatchesSession(
  status: ExternalSubagentStatus,
  sessionPath: string | undefined,
): boolean {
  if (sessionPath === undefined) return true;
  if (status.sessionFile === sessionPath) return true;
  return true;
}

export async function getExternalSubagentStatusForRun(
  runId: string | undefined,
): Promise<ExternalSubagentStatus | undefined> {
  const root = rootRunId(runId);
  if (root === undefined || root.length === 0) return undefined;
  return readStatusByRoot(root);
}

export async function getExternalSubagentStatusForSession(info: {
  runId?: string | undefined;
  path?: string | undefined;
}): Promise<ExternalSubagentStatus | undefined> {
  const status = await getExternalSubagentStatusForRun(info.runId);
  if (status === undefined) return undefined;
  if (!statusMatchesSession(status, info.path)) return undefined;
  return status;
}

export async function isExternallyActiveSubagentSession(info: {
  runId?: string | undefined;
  path?: string | undefined;
}): Promise<boolean> {
  const status = await getExternalSubagentStatusForSession(info);
  return status?.isExternalLive === true;
}

export function readSessionMessagesFromDisk(
  sessionPath: string,
  workspacePath: string,
): AgentMessage[] {
  const manager = SessionManager.open(sessionPath, undefined, workspacePath);
  return manager.buildSessionContext().messages;
}

function formatCompletionContent(
  result: AsyncResultFile | undefined,
  status: ExternalSubagentStatus,
): string {
  const state =
    result?.state === "paused" || status.state === "paused"
      ? "paused"
      : result?.success === false || status.state === "failed"
        ? "failed"
        : "completed";
  const agent = result?.agent ?? result?.results?.[0]?.agent ?? "subagent";
  const summary =
    result?.summary ??
    result?.results?.[0]?.output ??
    result?.results?.[0]?.error ??
    `(background run ${status.rootRunId} ${state})`;
  const sessionFile =
    result?.sessionFile ??
    result?.results?.find((r) => typeof r.sessionFile === "string")?.sessionFile ??
    status.sessionFile;
  return [
    `Background task ${state}: **${agent}**`,
    "",
    summary.trim() || "(no output)",
    sessionFile ? "" : undefined,
    sessionFile ? `Session file: ${sessionFile}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export async function deliverExternalSubagentCompletionForRun(root: string): Promise<void> {
  const status = await readStatusByRoot(root);
  if (status === undefined || !TERMINAL_STATES.has(status.state)) return;
  const resultPath = join(SUBAGENTS_RESULTS_DIR, `${root}.json`);
  const result = await readJson<AsyncResultFile>(resultPath);
  const parentId = result?.sessionId ?? status.parentSessionId;
  if (parentId === undefined) return;
  const live = getSession(parentId);
  if (live === undefined) return;
  const key = `${parentId}:${root}:${status.state}`;
  if (deliveredCompletionKeys.has(key)) return;
  deliveredCompletionKeys.add(key);
  const content = formatCompletionContent(result, status);
  await live.session.sendCustomMessage(
    { customType: "subagent-notify", content, display: true },
    { triggerTurn: false },
  );
  for (const c of live.clients) {
    c.send({
      type: "session_list_changed",
      sessionId: parentId,
      projectId: live.projectId,
      reason: "subagent_async_complete",
    });
  }
}

async function scanTerminalCompletions(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(SUBAGENTS_ASYNC_DIR);
  } catch {
    return;
  }
  await Promise.all(entries.map((root) => deliverExternalSubagentCompletionForRun(root)));
}

export function startExternalSubagentsWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  void scanTerminalCompletions();
  scanTimer = setInterval(() => void scanTerminalCompletions(), 3000);
  scanTimer.unref?.();
  try {
    asyncWatcher = watch(SUBAGENTS_ASYNC_DIR, () => void scanTerminalCompletions());
    asyncWatcher.unref?.();
  } catch {
    // Directory may not exist until pi-subagents first runs. Explicit checks in routes still work.
  }
  try {
    resultsWatcher = watch(SUBAGENTS_RESULTS_DIR, () => void scanTerminalCompletions());
    resultsWatcher.unref?.();
  } catch {
    // Result files are optional and may be consumed by pi-subagents itself.
  }
}

export function stopExternalSubagentsWatcher(): void {
  asyncWatcher?.close();
  resultsWatcher?.close();
  if (scanTimer !== undefined) clearInterval(scanTimer);
  asyncWatcher = undefined;
  resultsWatcher = undefined;
  scanTimer = undefined;
  watcherStarted = false;
}
