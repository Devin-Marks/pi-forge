import { createSHA256 } from "hash-wasm";
import { clearStoredToken, getStoredToken } from "../auth-client";
import {
  ApiError,
  UNAUTHORIZED_EVENT,
  type AuthStatusResponse,
  type LoginResponse,
  type ChangePasswordResponse,
  type McpServerConfig,
  type McpServerStatus,
  type McpServersResponse,
  type McpSettingsResponse,
  type McpToolSummary,
  type Project,
  type BrowseEntry,
  type BrowseResponse,
  type HealthResponse,
  type UiConfigResponse,
  type UnifiedSession,
  type SessionSummary,
  type SkillSummary,
  type ToolListing,
  type ToolOverridesResponse,
  type ProvidersListing,
  type AuthSummary,
  type FileTreeNode,
  type FileReadResponse,
  type TurnDiffEntry,
  type GitFileStatusKind,
  type GitFileStatus,
  type GitStatus,
  type GitDiffResponse,
  type GitLogEntry,
  type GitLogResponse,
  type GitBranch,
  type GitBranchesResponse,
  type GitRemote,
  type GitRemotesResponse,
  type SearchMatch,
  type SearchResponse,
  type SearchOptions,
  type SessionTreeEntry,
  type ContextTurn,
  type ContextUsageStats,
  type SessionContextResponse,
  type SessionTreeResponse,
  type UploadedFile,
  type UploadResponse,
  type RequestOpts,
  type Validator,
} from "./types";

// Public type surface lives in ./types so consumers and the request
// machinery can both import without coupling. Re-exported here so the
// existing `import { ApiError, ... } from "../lib/api-client"` calls
// across components continue to work without path changes.
export * from "./types";

export function onUnauthorized(handler: () => void): () => void {
  const fn = (): void => handler();
  window.addEventListener(UNAUTHORIZED_EVENT, fn);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, fn);
}

function fail(status: number, hint: string): never {
  throw new ApiError(status, "invalid_response_body", hint);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const vVoid: Validator<undefined> = (value, status) => {
  if (value !== undefined) fail(status, "expected empty body");
  return undefined;
};

const vString =
  (path: string): Validator<string> =>
  (value, status) => {
    if (typeof value !== "string") fail(status, `${path}: expected string`);
    return value;
  };

function vAuthStatus(value: unknown, status: number): AuthStatusResponse {
  if (!isObject(value) || typeof value.authEnabled !== "boolean") {
    fail(status, "expected { authEnabled: boolean }");
  }
  return { authEnabled: value.authEnabled };
}

function vLogin(value: unknown, status: number): LoginResponse {
  if (
    !isObject(value) ||
    typeof value.token !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.mustChangePassword !== "boolean"
  ) {
    fail(status, "expected { token, expiresAt, mustChangePassword }");
  }
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    mustChangePassword: value.mustChangePassword,
  };
}

function vChangePassword(value: unknown, status: number): ChangePasswordResponse {
  return vLogin(value, status);
}

function vUiConfig(value: unknown, status: number): UiConfigResponse {
  if (
    !isObject(value) ||
    typeof value.minimal !== "boolean" ||
    typeof value.workspaceRoot !== "string"
  ) {
    fail(status, "expected { minimal: boolean, workspaceRoot: string }");
  }
  // `version` is forward-compatible: older servers without the field
  // fall through to "unknown" so the About tab still renders.
  const version = typeof value.version === "string" ? value.version : "unknown";
  return { minimal: value.minimal, workspaceRoot: value.workspaceRoot, version };
}

function vHealth(value: unknown, status: number): HealthResponse {
  if (
    !isObject(value) ||
    value.status !== "ok" ||
    typeof value.activeSessions !== "number" ||
    typeof value.activePtys !== "number"
  ) {
    fail(status, "expected { status: 'ok', activeSessions, activePtys }");
  }
  return {
    status: "ok",
    activeSessions: value.activeSessions,
    activePtys: value.activePtys,
  };
}

function vProject(value: unknown, status: number): Project {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    fail(status, "expected Project");
  }
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    createdAt: value.createdAt,
  };
}

function vProjectList(value: unknown, status: number): { projects: Project[] } {
  if (!isObject(value) || !Array.isArray(value.projects)) {
    fail(status, "expected { projects: Project[] }");
  }
  return { projects: value.projects.map((p) => vProject(p, status)) };
}

function vBrowseEntry(value: unknown, status: number): BrowseEntry {
  if (
    !isObject(value) ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.isGitRepo !== "boolean"
  ) {
    fail(status, "expected BrowseEntry");
  }
  return { name: value.name, path: value.path, isGitRepo: value.isGitRepo };
}

function vBrowse(value: unknown, status: number): BrowseResponse {
  if (
    !isObject(value) ||
    typeof value.path !== "string" ||
    !(
      value.parentPath === null ||
      value.parentPath === undefined ||
      typeof value.parentPath === "string"
    ) ||
    !Array.isArray(value.entries)
  ) {
    fail(status, "expected BrowseResponse");
  }
  // Normalize undefined → null so consumers see a single absent shape.
  // The server route already sends `null` (routes/projects.ts), but a
  // future refactor that drops the `?? null` would otherwise produce a
  // confusing "expected BrowseResponse" instead of a useful surface.
  return {
    path: value.path,
    parentPath: typeof value.parentPath === "string" ? value.parentPath : null,
    entries: value.entries.map((e) => vBrowseEntry(e, status)),
  };
}

function vMkdir(value: unknown, status: number): { path: string } {
  if (!isObject(value) || typeof value.path !== "string") {
    fail(status, "expected { path }");
  }
  return { path: value.path };
}

function vUnifiedSession(value: unknown, status: number): UnifiedSession {
  if (
    !isObject(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.isLive !== "boolean" ||
    typeof value.workspacePath !== "string" ||
    typeof value.lastActivityAt !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.messageCount !== "number" ||
    typeof value.firstMessage !== "string"
  ) {
    fail(status, "expected UnifiedSession");
  }
  const out: UnifiedSession = {
    sessionId: value.sessionId,
    projectId: value.projectId,
    isLive: value.isLive,
    workspacePath: value.workspacePath,
    lastActivityAt: value.lastActivityAt,
    createdAt: value.createdAt,
    messageCount: value.messageCount,
    firstMessage: value.firstMessage,
  };
  if (typeof value.name === "string") out.name = value.name;
  return out;
}

function vUnifiedSessionList(value: unknown, status: number): { sessions: UnifiedSession[] } {
  if (!isObject(value) || !Array.isArray(value.sessions)) {
    fail(status, "expected { sessions: UnifiedSession[] }");
  }
  return { sessions: value.sessions.map((s) => vUnifiedSession(s, status)) };
}

function vSessionSummary(value: unknown, status: number): SessionSummary {
  if (
    !isObject(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastActivityAt !== "string" ||
    typeof value.isLive !== "boolean" ||
    typeof value.messageCount !== "number" ||
    typeof value.isStreaming !== "boolean"
  ) {
    fail(status, "expected SessionSummary");
  }
  const out: SessionSummary = {
    sessionId: value.sessionId,
    projectId: value.projectId,
    workspacePath: value.workspacePath,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    isLive: value.isLive,
    messageCount: value.messageCount,
    isStreaming: value.isStreaming,
  };
  if (typeof value.name === "string") out.name = value.name;
  return out;
}

function vAccepted(value: unknown, status: number): { accepted: true } {
  if (!isObject(value) || value.accepted !== true) fail(status, "expected { accepted: true }");
  return { accepted: true };
}

function vSkillsList(value: unknown, status: number): { skills: SkillSummary[] } {
  if (!isObject(value) || !Array.isArray(value.skills)) {
    fail(status, "expected { skills: SkillSummary[] }");
  }
  return {
    skills: value.skills.map((s): SkillSummary => {
      if (
        !isObject(s) ||
        typeof s.name !== "string" ||
        typeof s.description !== "string" ||
        (s.source !== "global" && s.source !== "project") ||
        typeof s.filePath !== "string" ||
        typeof s.enabled !== "boolean" ||
        typeof s.effective !== "boolean" ||
        typeof s.disableModelInvocation !== "boolean"
      ) {
        fail(status, "expected SkillSummary");
      }
      const summary: SkillSummary = {
        name: s.name,
        description: s.description,
        source: s.source,
        filePath: s.filePath,
        enabled: s.enabled,
        effective: s.effective,
        disableModelInvocation: s.disableModelInvocation,
      };
      if (s.projectOverride === "enabled" || s.projectOverride === "disabled") {
        summary.projectOverride = s.projectOverride;
      }
      return summary;
    }),
  };
}

function vSkillOverrides(
  value: unknown,
  status: number,
): { projects: Record<string, { enable: string[]; disable: string[] }> } {
  if (!isObject(value) || !isObject(value.projects)) {
    fail(status, "expected { projects: { ... } }");
  }
  const out: Record<string, { enable: string[]; disable: string[] }> = {};
  for (const [pid, val] of Object.entries(value.projects)) {
    if (!isObject(val)) continue;
    const enable = Array.isArray(val.enable)
      ? val.enable.filter((x): x is string => typeof x === "string")
      : [];
    const disable = Array.isArray(val.disable)
      ? val.disable.filter((x): x is string => typeof x === "string")
      : [];
    out[pid] = { enable, disable };
  }
  return { projects: out };
}

function vProvidersListing(value: unknown, status: number): ProvidersListing {
  if (!isObject(value) || !Array.isArray(value.providers)) {
    fail(status, "expected { providers: [...] }");
  }
  return { providers: value.providers as ProvidersListing["providers"] };
}

function vMcpServers(value: unknown, status: number): McpServersResponse {
  if (!isObject(value) || !isObject(value.servers) || !Array.isArray(value.status)) {
    fail(status, "expected { servers, status[] }");
  }
  return value as unknown as McpServersResponse;
}

function vMcpSettings(value: unknown, status: number): McpSettingsResponse {
  if (
    !isObject(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.connected !== "number" ||
    typeof value.total !== "number"
  ) {
    fail(status, "expected { enabled, connected, total }");
  }
  return {
    enabled: value.enabled,
    connected: value.connected,
    total: value.total,
  };
}

function vMcpProbe(value: unknown, status: number): { status: McpServerStatus } {
  if (!isObject(value) || !isObject(value.status)) {
    fail(status, "expected { status: {...} }");
  }
  return { status: value.status as unknown as McpServerStatus };
}

function vMcpTools(value: unknown, status: number): { tools: McpToolSummary[] } {
  if (!isObject(value) || !Array.isArray(value.tools)) {
    fail(status, "expected { tools: [...] }");
  }
  return { tools: value.tools as McpToolSummary[] };
}

function vMcpUpsert(value: unknown, status: number): { ok: true } {
  if (!isObject(value) || value.ok !== true) {
    fail(status, "expected { ok: true }");
  }
  return { ok: true };
}

function vMcpDelete(value: unknown, status: number): { removed: boolean } {
  if (!isObject(value) || typeof value.removed !== "boolean") {
    fail(status, "expected { removed: boolean }");
  }
  return { removed: value.removed };
}

function vAuthSummary(value: unknown, status: number): AuthSummary {
  if (!isObject(value) || !isObject(value.providers)) {
    fail(status, "expected { providers: { ... } }");
  }
  return value as unknown as AuthSummary;
}

function vSettings(value: unknown, status: number): Record<string, unknown> {
  if (!isObject(value)) fail(status, "expected settings object");
  return value;
}

function vModelsJson(value: unknown, status: number): { providers: Record<string, unknown> } {
  if (!isObject(value) || !isObject(value.providers)) {
    fail(status, "expected { providers: {...} }");
  }
  return value as { providers: Record<string, unknown> };
}

function vFileTreeNode(value: unknown, status: number): FileTreeNode {
  if (!isObject(value)) fail(status, "expected FileTreeNode");
  const type = value.type;
  if (
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    (type !== "file" && type !== "directory")
  ) {
    fail(status, "expected FileTreeNode");
  }
  const out: FileTreeNode = { name: value.name, path: value.path, type };
  if (Array.isArray(value.children)) {
    out.children = value.children.map((c) => vFileTreeNode(c, status));
  }
  if (typeof value.truncated === "boolean") out.truncated = value.truncated;
  return out;
}

function vFileRead(value: unknown, status: number): FileReadResponse {
  if (
    !isObject(value) ||
    typeof value.path !== "string" ||
    typeof value.content !== "string" ||
    typeof value.size !== "number" ||
    typeof value.language !== "string" ||
    typeof value.binary !== "boolean"
  ) {
    fail(status, "expected FileReadResponse");
  }
  return {
    path: value.path,
    content: value.content,
    size: value.size,
    language: value.language,
    binary: value.binary,
  };
}

function vTurnDiff(value: unknown, status: number): { entries: TurnDiffEntry[] } {
  if (!isObject(value) || !Array.isArray(value.entries)) {
    fail(status, "expected { entries: TurnDiffEntry[] }");
  }
  return {
    entries: value.entries.map((e): TurnDiffEntry => {
      if (
        !isObject(e) ||
        typeof e.file !== "string" ||
        (e.tool !== "write" && e.tool !== "edit") ||
        typeof e.diff !== "string" ||
        typeof e.additions !== "number" ||
        typeof e.deletions !== "number" ||
        typeof e.isPureAddition !== "boolean"
      ) {
        fail(status, "expected TurnDiffEntry");
      }
      return {
        file: e.file,
        tool: e.tool,
        diff: e.diff,
        additions: e.additions,
        deletions: e.deletions,
        isPureAddition: e.isPureAddition,
      };
    }),
  };
}

function vGitStatus(value: unknown, status: number): GitStatus {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.files)) {
    fail(status, "expected GitStatus");
  }
  const out: GitStatus = {
    isGitRepo: value.isGitRepo,
    files: value.files.map((f): GitFileStatus => {
      if (
        !isObject(f) ||
        typeof f.path !== "string" ||
        typeof f.staged !== "boolean" ||
        typeof f.unstaged !== "boolean" ||
        typeof f.kind !== "string" ||
        typeof f.code !== "string"
      ) {
        fail(status, "expected GitFileStatus");
      }
      const entry: GitFileStatus = {
        path: f.path,
        staged: f.staged,
        unstaged: f.unstaged,
        kind: f.kind as GitFileStatusKind,
        code: f.code,
      };
      if (typeof f.originalPath === "string") entry.originalPath = f.originalPath;
      return entry;
    }),
  };
  if (typeof value.branch === "string") out.branch = value.branch;
  return out;
}

function vGitDiff(value: unknown, status: number): GitDiffResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || typeof value.diff !== "string") {
    fail(status, "expected GitDiffResponse");
  }
  return { isGitRepo: value.isGitRepo, diff: value.diff };
}

function vGitLog(value: unknown, status: number): GitLogResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.commits)) {
    fail(status, "expected GitLogResponse");
  }
  return {
    isGitRepo: value.isGitRepo,
    commits: value.commits.map((c): GitLogEntry => {
      if (
        !isObject(c) ||
        typeof c.hash !== "string" ||
        typeof c.message !== "string" ||
        typeof c.author !== "string" ||
        typeof c.date !== "string" ||
        !Array.isArray(c.parents) ||
        !Array.isArray(c.refs)
      ) {
        fail(status, "expected GitLogEntry");
      }
      return {
        hash: c.hash,
        message: c.message,
        author: c.author,
        date: c.date,
        parents: c.parents.filter((p): p is string => typeof p === "string"),
        refs: c.refs.filter((r): r is string => typeof r === "string"),
      };
    }),
  };
}

function vGitBranches(value: unknown, status: number): GitBranchesResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.branches)) {
    fail(status, "expected GitBranchesResponse");
  }
  const out: GitBranchesResponse = {
    isGitRepo: value.isGitRepo,
    branches: value.branches.map((b): GitBranch => {
      if (
        !isObject(b) ||
        typeof b.name !== "string" ||
        typeof b.current !== "boolean" ||
        typeof b.remote !== "boolean"
      ) {
        fail(status, "expected GitBranch");
      }
      return { name: b.name, current: b.current, remote: b.remote };
    }),
  };
  if (typeof value.current === "string") out.current = value.current;
  return out;
}

function vSessionContext(value: unknown, status: number): SessionContextResponse {
  if (
    !isObject(value) ||
    !Array.isArray(value.messages) ||
    typeof value.totalInputTokens !== "number" ||
    typeof value.totalOutputTokens !== "number" ||
    typeof value.totalCacheReadTokens !== "number" ||
    typeof value.totalCacheWriteTokens !== "number" ||
    typeof value.totalTokens !== "number" ||
    typeof value.totalCost !== "number" ||
    !Array.isArray(value.turns) ||
    !isObject(value.contextUsage)
  ) {
    fail(status, "expected SessionContextResponse");
  }
  const turns = value.turns.map((t): ContextTurn => {
    if (
      !isObject(t) ||
      typeof t.index !== "number" ||
      typeof t.inputTokens !== "number" ||
      typeof t.outputTokens !== "number" ||
      typeof t.cacheReadTokens !== "number" ||
      typeof t.cacheWriteTokens !== "number" ||
      typeof t.totalTokens !== "number" ||
      typeof t.cost !== "number" ||
      typeof t.model !== "string" ||
      typeof t.provider !== "string" ||
      typeof t.timestamp !== "number"
    ) {
      fail(status, "expected ContextTurn");
    }
    const out: ContextTurn = {
      index: t.index,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      totalTokens: t.totalTokens,
      cost: t.cost,
      model: t.model,
      provider: t.provider,
      timestamp: t.timestamp,
    };
    if (typeof t.stopReason === "string") out.stopReason = t.stopReason;
    return out;
  });
  const cu = value.contextUsage;
  const contextUsage: ContextUsageStats = {
    contextWindow: typeof cu.contextWindow === "number" ? cu.contextWindow : 0,
  };
  if (typeof cu.tokens === "number") contextUsage.tokens = cu.tokens;
  if (typeof cu.percent === "number") contextUsage.percent = cu.percent;
  return {
    messages: value.messages.filter((m): m is Record<string, unknown> => isObject(m)),
    totalInputTokens: value.totalInputTokens,
    totalOutputTokens: value.totalOutputTokens,
    totalCacheReadTokens: value.totalCacheReadTokens,
    totalCacheWriteTokens: value.totalCacheWriteTokens,
    totalTokens: value.totalTokens,
    totalCost: value.totalCost,
    turns,
    contextUsage,
  };
}

function vSessionTree(value: unknown, status: number): SessionTreeResponse {
  if (
    !isObject(value) ||
    !(value.leafId === null || typeof value.leafId === "string") ||
    !Array.isArray(value.branchIds) ||
    !Array.isArray(value.entries)
  ) {
    fail(status, "expected SessionTreeResponse");
  }
  const branchIds = value.branchIds.filter((b): b is string => typeof b === "string");
  const entries = value.entries.map((e): SessionTreeEntry => {
    if (
      !isObject(e) ||
      typeof e.id !== "string" ||
      !(e.parentId === null || typeof e.parentId === "string") ||
      typeof e.type !== "string" ||
      typeof e.timestamp !== "string"
    ) {
      fail(status, "expected SessionTreeEntry");
    }
    const out: SessionTreeEntry = {
      id: e.id,
      parentId: e.parentId,
      type: e.type,
      timestamp: e.timestamp,
    };
    if (typeof e.role === "string") out.role = e.role;
    if (typeof e.preview === "string") out.preview = e.preview;
    if (typeof e.label === "string") out.label = e.label;
    return out;
  });
  return { leafId: value.leafId, branchIds, entries };
}

function vUploadResponse(value: unknown, status: number): UploadResponse {
  if (!isObject(value) || !Array.isArray(value.files)) {
    fail(status, "expected { files: UploadedFile[] }");
  }
  return {
    files: value.files.map((f): UploadedFile => {
      if (
        !isObject(f) ||
        typeof f.path !== "string" ||
        typeof f.size !== "number" ||
        typeof f.sha256 !== "string"
      ) {
        fail(status, "expected UploadedFile");
      }
      return { path: f.path, size: f.size, sha256: f.sha256 };
    }),
  };
}

function vSearchResponse(value: unknown, status: number): SearchResponse {
  if (
    !isObject(value) ||
    (value.engine !== "ripgrep" && value.engine !== "node") ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.matches)
  ) {
    fail(status, "expected SearchResponse");
  }
  return {
    engine: value.engine,
    truncated: value.truncated,
    matches: value.matches.map((m): SearchMatch => {
      if (
        !isObject(m) ||
        typeof m.path !== "string" ||
        typeof m.line !== "number" ||
        typeof m.column !== "number" ||
        typeof m.length !== "number" ||
        typeof m.lineSnippet !== "string"
      ) {
        fail(status, "expected SearchMatch");
      }
      return {
        path: m.path,
        line: m.line,
        column: m.column,
        length: m.length,
        lineSnippet: m.lineSnippet,
      };
    }),
  };
}

function vGitRemotes(value: unknown, status: number): GitRemotesResponse {
  if (!isObject(value) || typeof value.isGitRepo !== "boolean" || !Array.isArray(value.remotes)) {
    fail(status, "expected GitRemotesResponse");
  }
  return {
    isGitRepo: value.isGitRepo,
    remotes: value.remotes.map((r): GitRemote => {
      if (
        !isObject(r) ||
        typeof r.name !== "string" ||
        typeof r.fetchUrl !== "string" ||
        typeof r.pushUrl !== "string"
      ) {
        fail(status, "expected GitRemote");
      }
      return { name: r.name, fetchUrl: r.fetchUrl, pushUrl: r.pushUrl };
    }),
  };
}

function vPathOnly(value: unknown, status: number): { path: string } {
  if (!isObject(value) || typeof value.path !== "string") {
    fail(status, "expected { path: string }");
  }
  return { path: value.path };
}

/**
 * Hash a Blob (File is a Blob) with SHA-256 by reading it through a
 * `ReadableStream` and feeding each chunk to a hash-wasm hasher.
 * Streaming matters because uploads can be hundreds of MB — a full
 * `arrayBuffer()` load would OOM the tab. Returns a lowercase-hex
 * digest. `onChunk` reports the byte count of each chunk as it
 * passes through, used by the UI for progress.
 */
async function streamSha256(blob: Blob, onChunk?: (delta: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  // Browsers prior to 2022 don't support Blob.stream(); the broad
  // baseline target here (Chromium / WebKit / Firefox in PWA mode) all
  // do, so we don't bother with a FileReader fallback.
  const reader = blob.stream().getReader();
  let cancelled = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Some browsers hand back chunks larger than HASH_CHUNK_BYTES;
      // hash-wasm handles arbitrary sizes, so we don't slice.
      hasher.update(value);
      onChunk?.(value.byteLength);
    }
  } catch (err) {
    // hash-wasm error mid-stream — actively cancel the underlying
    // stream so the browser releases buffered chunks instead of
    // waiting on GC. Without this, an exception partway through a
    // 500MB upload could keep that 500MB resident in memory until the
    // next major GC.
    cancelled = true;
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    if (!cancelled) reader.releaseLock();
  }
  return hasher.digest("hex");
}

/**
 * Parse the filename out of a Content-Disposition header. Prefers
 * `filename*` (RFC 5987) when present so we get the original
 * non-ASCII name; falls back to the legacy `filename=` value.
 */
function parseContentDispositionFilename(header: string): string | undefined {
  const star = /filename\*=UTF-8''([^;\r\n]+)/i.exec(header);
  if (star !== null) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      // fall through
    }
  }
  const ascii = /filename="([^"]+)"/i.exec(header) ?? /filename=([^;\r\n]+)/i.exec(header);
  if (ascii !== null) return ascii[1];
  return undefined;
}

function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // Non-JSON body (HTML error page from a proxy, network HTML).
    // Caller distinguishes invalid_error_body vs invalid_response_body
    // by ok-status; this function only signals parse success.
    return { ok: false };
  }
}

async function request<T>(
  path: string,
  validator: Validator<T>,
  opts: RequestOpts = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts.skipAuth) {
    const stored = getStoredToken();
    if (stored) headers.Authorization = `Bearer ${stored.token}`;
  }
  // FormData bodies (multipart uploads) — let the browser set
  // Content-Type with the auto-generated boundary. Setting it
  // manually here would break parsing on the server because we
  // can't compute the boundary string.
  const isFormData = opts.body instanceof FormData;
  if (opts.body !== undefined && !isFormData) headers["Content-Type"] = "application/json";

  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    init.body = isFormData ? (opts.body as FormData) : JSON.stringify(opts.body);
  }
  if (opts.signal !== undefined) init.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", (err as Error).message);
  }

  if (res.status === 401 && !opts.skipAuth) {
    clearStoredToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  const text = await res.text();
  const parsed = safeParseJson(text);

  if (!res.ok) {
    // Distinguish three failure shapes so consumers branching on
    // err.code can tell them apart:
    //   - server returned a typed error envelope ({ error, message? }):
    //     pass through the error code verbatim
    //   - server returned a 4xx/5xx with valid JSON but no `error` field:
    //     synthesize `request_failed`
    //   - server returned a 4xx/5xx with non-JSON body (HTML error page,
    //     proxy intercept, network HTML): `invalid_error_body` so it's
    //     distinct from the 2xx-non-JSON case below
    let code: string;
    if (parsed.ok && isObject(parsed.value) && "error" in parsed.value) {
      code = String((parsed.value as { error: unknown }).error);
    } else if (parsed.ok) {
      code = "request_failed";
    } else {
      code = "invalid_error_body";
    }
    throw new ApiError(res.status, code, parsed.ok ? undefined : `non-JSON ${res.status} body`);
  }

  if (!parsed.ok) {
    throw new ApiError(res.status, "invalid_response_body", "server returned non-JSON 2xx body");
  }

  return validator(parsed.value, res.status);
}

export const api = {
  authStatus: () => request("/api/v1/auth/status", vAuthStatus, { skipAuth: true }),
  login: (password: string) =>
    request("/api/v1/auth/login", vLogin, {
      method: "POST",
      body: { password },
      skipAuth: true,
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request("/api/v1/auth/change-password", vChangePassword, {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
  health: () => request("/api/v1/health", vHealth, { skipAuth: true }),
  uiConfig: () => request("/api/v1/ui-config", vUiConfig, { skipAuth: true }),
  listProjects: () => request("/api/v1/projects", vProjectList),
  createProject: (name: string, path: string) =>
    request("/api/v1/projects", vProject, { method: "POST", body: { name, path } }),
  renameProject: (id: string, name: string) =>
    request(`/api/v1/projects/${encodeURIComponent(id)}`, vProject, {
      method: "PATCH",
      body: { name },
    }),
  deleteProject: (id: string, opts?: { cascade?: boolean }) => {
    const qs = opts?.cascade === true ? "?cascade=1" : "";
    return request(
      `/api/v1/projects/${encodeURIComponent(id)}${qs}`,
      (v, s) => {
        if (!isObject(v) || typeof v.cascaded !== "boolean") fail(s, "expected { cascaded }");
        return { cascaded: v.cascaded };
      },
      { method: "DELETE" },
    );
  },
  browse: (path?: string) => {
    const qs = path !== undefined ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/v1/projects/browse${qs}`, vBrowse);
  },
  mkdir: (parentPath: string, name: string) =>
    request("/api/v1/projects/browse/mkdir", vMkdir, {
      method: "POST",
      body: { parentPath, name },
    }),

  // ---------------- sessions ----------------
  listSessions: (projectId?: string) => {
    const qs = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/v1/sessions${qs}`, vUnifiedSessionList);
  },
  createSession: (projectId: string) =>
    request("/api/v1/sessions", vSessionSummary, {
      method: "POST",
      body: { projectId },
    }),
  getSession: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}`, vSessionSummary),
  getMessages: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, (v, s) => {
      if (!isObject(v) || !Array.isArray(v.messages)) {
        fail(s, "expected { messages: [...] }");
      }
      return { messages: v.messages as Record<string, unknown>[] };
    }),
  disposeSession: (id: string, opts?: { hard?: boolean }) => {
    const qs = opts?.hard === true ? "?hard=1" : "";
    return request(`/api/v1/sessions/${encodeURIComponent(id)}${qs}`, vVoid, { method: "DELETE" });
  },
  renameSession: (id: string, name: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/name`, vSessionSummary, {
      method: "POST",
      body: { name },
    }),
  getSessionContext: (id: string, signal?: AbortSignal) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(id)}/context`,
      vSessionContext,
      signal !== undefined ? { signal } : {},
    ),
  getSessionTree: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/tree`, vSessionTree),
  navigateSession: (
    id: string,
    entryId: string,
    opts?: { summarize?: boolean; customInstructions?: string; label?: string },
  ) => {
    const body: Record<string, unknown> = { entryId };
    if (opts?.summarize !== undefined) body.summarize = opts.summarize;
    if (opts?.customInstructions !== undefined) body.customInstructions = opts.customInstructions;
    if (opts?.label !== undefined) body.label = opts.label;
    return request(
      `/api/v1/sessions/${encodeURIComponent(id)}/navigate`,
      (v, s) => {
        if (!isObject(v)) fail(s, "expected navigate result");
        return v;
      },
      { method: "POST", body },
    );
  },
  forkSession: (id: string, entryId: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/fork`, vSessionSummary, {
      method: "POST",
      body: { entryId },
    }),
  getTurnDiff: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/turn-diff`, vTurnDiff),

  // ---------------- prompt + control ----------------
  prompt: (
    id: string,
    text: string,
    opts?: {
      streamingBehavior?: "steer" | "followUp";
      attachments?: File[];
    },
  ) => {
    // Multipart path when attachments are present — server splits
    // images vs text files by MIME type. JSON path otherwise to keep
    // the request lightweight in the common case.
    const path = `/api/v1/sessions/${encodeURIComponent(id)}/prompt`;
    if (opts?.attachments !== undefined && opts.attachments.length > 0) {
      const fd = new FormData();
      fd.append("text", text);
      if (opts.streamingBehavior !== undefined) {
        fd.append("streamingBehavior", opts.streamingBehavior);
      }
      for (const file of opts.attachments) {
        // Field name is "attachments" — server iterates `req.parts()`
        // and reads files by part.type === "file" regardless of
        // fieldname, so the choice is cosmetic but matches the dev
        // plan and the OpenAPI description.
        fd.append("attachments", file, file.name);
      }
      return request(path, vAccepted, { method: "POST", body: fd });
    }
    const body: Record<string, unknown> = { text };
    if (opts?.streamingBehavior !== undefined) body.streamingBehavior = opts.streamingBehavior;
    return request(path, vAccepted, { method: "POST", body });
  },
  steer: (id: string, text: string, mode?: "steer" | "followUp") => {
    const body: Record<string, unknown> = { text };
    if (mode !== undefined) body.mode = mode;
    return request(`/api/v1/sessions/${encodeURIComponent(id)}/steer`, vAccepted, {
      method: "POST",
      body,
    });
  },
  abort: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/abort`, vVoid, { method: "POST" }),
  /**
   * Manually compact the session context. Server route accepts an
   * optional customInstructions string; v1 of the slash-command
   * palette doesn't expose that surface, so we always omit it.
   */
  compact: (id: string) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(id)}/compact`,
      (v, s) => {
        if (!isObject(v)) fail(s, "expected compact result object");
        return {
          summary: typeof v.summary === "string" ? v.summary : undefined,
          tokensBefore: typeof v.tokensBefore === "number" ? v.tokensBefore : undefined,
          tokensAfter: typeof v.tokensAfter === "number" ? v.tokensAfter : undefined,
        };
      },
      { method: "POST", body: {} },
    ),
  /**
   * Run a one-shot bash command in the session's project cwd. Mirrors
   * pi-tui's `!` / `!!` semantics — the chat input dispatches here on
   * either prefix. With `excludeFromContext: true` (the `!!` form) the
   * resulting BashExecutionMessage is persisted to the session JSONL
   * but kept out of the next agent turn's LLM input.
   */
  exec: (id: string, command: string, opts?: { excludeFromContext?: boolean }) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(id)}/exec`,
      (v, s) => {
        if (
          !isObject(v) ||
          !("exitCode" in v) ||
          typeof v.output !== "string" ||
          typeof v.durationMs !== "number" ||
          typeof v.truncated !== "boolean" ||
          typeof v.cancelled !== "boolean"
        ) {
          fail(s, "expected { exitCode, output, durationMs, truncated, cancelled }");
        }
        return {
          exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
          output: v.output,
          durationMs: v.durationMs,
          truncated: v.truncated,
          cancelled: v.cancelled,
        };
      },
      {
        method: "POST",
        body: { command, excludeFromContext: opts?.excludeFromContext === true },
      },
    ),
  setModel: (id: string, provider: string, modelId: string) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(id)}/model`,
      (v, s) => {
        if (!isObject(v) || typeof v.provider !== "string" || typeof v.modelId !== "string") {
          fail(s, "expected { provider, modelId }");
        }
        return { provider: v.provider, modelId: v.modelId };
      },
      { method: "POST", body: { provider, modelId } },
    ),

  // ---------------- config ----------------
  getModelsJson: () => request("/api/v1/config/models", vModelsJson),
  setModelsJson: (data: { providers: Record<string, unknown> }) =>
    request("/api/v1/config/models", vModelsJson, { method: "PUT", body: data }),
  getProviders: () => request("/api/v1/config/providers", vProvidersListing),
  getSettings: () => request("/api/v1/config/settings", vSettings),
  updateSettings: (patch: Record<string, unknown>) =>
    request("/api/v1/config/settings", vSettings, { method: "PUT", body: patch }),
  getAuthSummary: () => request("/api/v1/config/auth", vAuthSummary),
  setApiKey: (provider: string, apiKey: string) =>
    request(
      `/api/v1/config/auth/${encodeURIComponent(provider)}`,
      (v, s) => {
        if (!isObject(v) || typeof v.provider !== "string" || v.configured !== true) {
          fail(s, "expected { provider, configured: true }");
        }
        return { provider: v.provider, configured: true as const };
      },
      { method: "PUT", body: { apiKey } },
    ),
  removeApiKey: (provider: string) =>
    request(`/api/v1/config/auth/${encodeURIComponent(provider)}`, vVoid, {
      method: "DELETE",
    }),

  // ---------------- mcp ----------------
  getMcpSettings: () => request("/api/v1/mcp/settings", vMcpSettings),
  setMcpEnabled: (enabled: boolean) =>
    request("/api/v1/mcp/settings", vMcpSettings, {
      method: "PUT",
      body: { enabled },
    }),
  /** GLOBAL servers (config + status). Pass projectId to also include
   *  status entries for the project's `.mcp.json` servers. */
  listMcpServers: (projectId?: string) => {
    const qs = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/v1/mcp/servers${qs}`, vMcpServers);
  },
  upsertMcpServer: (name: string, body: McpServerConfig) =>
    request(`/api/v1/mcp/servers/${encodeURIComponent(name)}`, vMcpUpsert, {
      method: "PUT",
      body,
    }),
  deleteMcpServer: (name: string) =>
    request(`/api/v1/mcp/servers/${encodeURIComponent(name)}`, vMcpDelete, {
      method: "DELETE",
    }),
  probeMcpServer: (name: string, projectId?: string) => {
    const qs = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/v1/mcp/servers/${encodeURIComponent(name)}/probe${qs}`, vMcpProbe, {
      method: "POST",
      body: {},
    });
  },
  listMcpTools: (projectId: string) =>
    request(`/api/v1/mcp/tools?projectId=${encodeURIComponent(projectId)}`, vMcpTools),
  listSkills: (projectId: string) =>
    request(`/api/v1/config/skills?projectId=${encodeURIComponent(projectId)}`, vSkillsList),
  /** Cascade view: every per-project override across every project. */
  listSkillOverrides: () => request(`/api/v1/config/skills/overrides`, vSkillOverrides),
  /**
   * Toggle a skill's enabled state. `scope` defaults to "global" for
   * back-compat with the original two-arg form. Project scope writes
   * the pi-forge-private overrides file; clear an override (= return
   * to inherit) via `clearSkillProjectOverride` below.
   */
  setSkillEnabled: (
    projectId: string,
    name: string,
    enabled: boolean,
    scope: "global" | "project" = "global",
  ) =>
    request(
      `/api/v1/config/skills/${encodeURIComponent(name)}/enabled?projectId=${encodeURIComponent(projectId)}`,
      vSkillsList,
      { method: "PUT", body: { enabled, scope } },
    ),
  /** Clear a project-scope override so the skill inherits from global. */
  clearSkillProjectOverride: (projectId: string, name: string) =>
    request(
      `/api/v1/config/skills/${encodeURIComponent(name)}/enabled?projectId=${encodeURIComponent(projectId)}`,
      vSkillsList,
      { method: "DELETE" },
    ),

  // ---------------- per-tool overrides ----------------
  /**
   * Unified tool listing — pi's seven builtins + every connected MCP
   * server's tools, each with an `enabled` flag reflecting the
   * pi-forge-private overrides file. Optional `?projectId=` includes
   * project-scope MCP servers.
   *
   * The server normalizes the response shape; we only sanity-check
   * the top-level keys so a future field addition doesn't break this
   * client (the new field just gets ignored at the validation
   * boundary).
   */
  listTools: (projectId?: string): Promise<ToolListing> => {
    const qs =
      projectId !== undefined && projectId.length > 0
        ? `?projectId=${encodeURIComponent(projectId)}`
        : "";
    return request(`/api/v1/config/tools${qs}`, (v) => {
      if (!isObject(v) || !Array.isArray(v.builtin) || !Array.isArray(v.mcp)) {
        throw new ApiError(0, "invalid_response_body");
      }
      return v as unknown as ToolListing;
    });
  },

  /**
   * Toggle a single tool. `family` is "builtin" (pi's shipped tools
   * — bash, read, etc.) or "mcp" (bridged tool name
   * `<server>__<tool>`).
   *
   * Default `scope: "global"` toggles the tool's GLOBAL state —
   * `enabled: false` adds it to the disabled set, `enabled: true`
   * removes it (allow-by-default semantics).
   *
   * `scope: "project"` (requires `projectId`) writes a tri-state
   * per-project override that wins over global: `enabled: true` is
   * an explicit project-enable; `enabled: false` an explicit
   * disable. Use `clearToolProjectOverride` to return a project to
   * inheriting the global default.
   */
  setToolEnabled: (
    family: "builtin" | "mcp",
    name: string,
    enabled: boolean,
    scope: "global" | "project" = "global",
    projectId?: string,
  ) => {
    const qs =
      scope === "project" && projectId !== undefined
        ? `?projectId=${encodeURIComponent(projectId)}`
        : "";
    return request(
      `/api/v1/config/tools/${family}/${encodeURIComponent(name)}/enabled${qs}`,
      (v) => {
        if (
          !isObject(v) ||
          typeof v.family !== "string" ||
          typeof v.name !== "string" ||
          typeof v.enabled !== "boolean" ||
          typeof v.scope !== "string"
        ) {
          throw new ApiError(0, "invalid_response_body");
        }
        return {
          family: v.family,
          name: v.name,
          enabled: v.enabled,
          scope: v.scope as "global" | "project",
        };
      },
      { method: "PUT", body: { enabled, scope } },
    );
  },

  /**
   * Cascade view: every per-project tool override across every
   * project, split per family. Used by the Tools tab + MCP cascade
   * to show "this tool is overridden in N projects" + the "Add
   * override for…" affordance. Mirrors `listSkillOverrides`.
   */
  listToolOverrides: (): Promise<ToolOverridesResponse> =>
    request("/api/v1/config/tools/overrides", (v) => {
      if (!isObject(v) || typeof v.projects !== "object" || v.projects === null) {
        throw new ApiError(0, "invalid_response_body");
      }
      return v as unknown as ToolOverridesResponse;
    }),

  /** Clear a per-project tool override so the project inherits the
   *  global default. Idempotent. */
  clearToolProjectOverride: (family: "builtin" | "mcp", name: string, projectId: string) =>
    request(
      `/api/v1/config/tools/${family}/${encodeURIComponent(name)}/enabled?projectId=${encodeURIComponent(projectId)}`,
      (v) => {
        if (
          !isObject(v) ||
          typeof v.family !== "string" ||
          typeof v.name !== "string" ||
          typeof v.projectId !== "string"
        ) {
          throw new ApiError(0, "invalid_response_body");
        }
        return { family: v.family, name: v.name, projectId: v.projectId };
      },
      { method: "DELETE" },
    ),

  // ---------------- config export / import ----------------
  /**
   * Download a `.tar.gz` of the pi-forge's portable config (mcp.json,
   * settings.json, models.json — auth.json deliberately excluded).
   * Returns a blob plus the filename the server suggested via
   * Content-Disposition AND the names actually packed (from the
   * `X-Pi-Forge-Files` header). The caller is responsible for
   * triggering the browser download (createObjectURL + anchor click).
   */
  exportConfig: async (): Promise<{ blob: Blob; filename: string; files: string[] }> => {
    const headers: Record<string, string> = {};
    const stored = getStoredToken();
    if (stored !== undefined) headers.Authorization = `Bearer ${stored.token}`;
    const res = await fetch("/api/v1/config/export", { headers });
    if (res.status === 401) {
      clearStoredToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new ApiError(401, "unauthorized");
    }
    if (!res.ok) {
      let code = "request_failed";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") code = body.error;
      } catch {
        // body wasn't JSON — keep generic code
      }
      throw new ApiError(res.status, code);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") ?? "";
    const filename = parseContentDispositionFilename(cd) ?? "pi-forge-config.tar.gz";
    const filesHeader = res.headers.get("X-Pi-Forge-Files") ?? "";
    const files = filesHeader.split(",").filter((s) => s.length > 0);
    return { blob, filename, files };
  },

  /**
   * Upload a previously-exported `.tar.gz` and apply it to disk on the
   * server. Returns the per-file summary so the UI can surface what
   * landed and what was skipped or failed validation. The whole import
   * is atomic per-file: any validation error means NOTHING is written
   * (`imported` will be empty, `errors` populated).
   */
  importConfig: (
    file: File,
  ): Promise<{
    imported: string[];
    skipped: string[];
    errors: { file: string; reason: string }[];
  }> => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return request(
      "/api/v1/config/import",
      (v) => {
        if (
          !isObject(v) ||
          !Array.isArray(v.imported) ||
          !Array.isArray(v.skipped) ||
          !Array.isArray(v.errors)
        ) {
          throw new ApiError(0, "invalid_response_body");
        }
        return v as {
          imported: string[];
          skipped: string[];
          errors: { file: string; reason: string }[];
        };
      },
      { method: "POST", body: fd },
    );
  },

  /**
   * Download a `.tar.gz` of the skills directory (`${piConfigDir}/
   * skills/`). Same blob+filename shape as `exportConfig` so the
   * download trigger logic in the UI can be shared.
   */
  exportSkills: async (): Promise<{ blob: Blob; filename: string; fileCount: number }> => {
    const headers: Record<string, string> = {};
    const stored = getStoredToken();
    if (stored !== undefined) headers.Authorization = `Bearer ${stored.token}`;
    const res = await fetch("/api/v1/config/skills/export", { headers });
    if (res.status === 401) {
      clearStoredToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new ApiError(401, "unauthorized");
    }
    if (!res.ok) {
      let code = "request_failed";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") code = body.error;
      } catch {
        // body wasn't JSON — keep generic code
      }
      throw new ApiError(res.status, code);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") ?? "";
    const filename = parseContentDispositionFilename(cd) ?? "pi-forge-skills.tar.gz";
    const countHeader = res.headers.get("X-Pi-Forge-File-Count") ?? "0";
    const fileCount = Number.parseInt(countHeader, 10) || 0;
    return { blob, filename, fileCount };
  },

  /**
   * Upload skills to the server. Accepts either a single tar.gz
   * (auto-detected by `.tar.gz` / `.tgz` suffix) OR a list of files
   * from a folder picker (`<input webkitdirectory>`); each file's
   * `webkitRelativePath` is sent as the multipart `filename` so the
   * server can preserve directory shape inside the skills tree.
   * Existing files at colliding paths are overwritten.
   */
  importSkills: (
    files: File[],
  ): Promise<{
    imported: string[];
    skipped: { name: string; reason: string }[];
  }> => {
    const fd = new FormData();
    for (const f of files) {
      // `webkitRelativePath` is non-empty only for entries from a
      // directory picker. Falls back to `f.name` for plain file
      // pickers (the tar.gz case).
      const relPath = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
      const name = relPath !== undefined && relPath.length > 0 ? relPath : f.name;
      fd.append("file", f, name);
    }
    return request(
      "/api/v1/config/skills/import",
      (v) => {
        if (!isObject(v) || !Array.isArray(v.imported) || !Array.isArray(v.skipped)) {
          throw new ApiError(0, "invalid_response_body");
        }
        return v as {
          imported: string[];
          skipped: { name: string; reason: string }[];
        };
      },
      { method: "POST", body: fd },
    );
  },

  // ---------------- files ----------------
  filesTree: (projectId: string, maxDepth?: number) => {
    const qs = new URLSearchParams({ projectId });
    if (maxDepth !== undefined) qs.set("maxDepth", String(maxDepth));
    return request(`/api/v1/files/tree?${qs.toString()}`, vFileTreeNode);
  },
  filesRead: (projectId: string, path: string) => {
    const qs = new URLSearchParams({ projectId, path });
    return request(`/api/v1/files/read?${qs.toString()}`, vFileRead);
  },
  filesWrite: (projectId: string, path: string, content: string) =>
    request("/api/v1/files/write", vPathOnly, {
      method: "PUT",
      body: { projectId, path, content },
    }),
  filesMkdir: (projectId: string, parentPath: string, name: string) =>
    request("/api/v1/files/mkdir", vPathOnly, {
      method: "POST",
      body: { projectId, parentPath, name },
    }),
  filesRename: (projectId: string, path: string, name: string) =>
    request("/api/v1/files/rename", vPathOnly, {
      method: "POST",
      body: { projectId, path, name },
    }),
  filesMove: (projectId: string, src: string, dest: string) =>
    request("/api/v1/files/move", vPathOnly, {
      method: "POST",
      body: { projectId, src, dest },
    }),
  filesDelete: (projectId: string, path: string, opts?: { recursive?: boolean }) => {
    const qs = new URLSearchParams({ projectId, path });
    if (opts?.recursive === true) qs.set("recursive", "true");
    return request(`/api/v1/files/delete?${qs.toString()}`, vVoid, { method: "DELETE" });
  },
  /**
   * Authed download of a file or directory. Files come down verbatim;
   * directories arrive as a gzipped tar (`<name>.tar.gz`). Returns a
   * Blob + the server-supplied filename so the caller can trigger an
   * `<a download>` click. We can't use a plain `<a href>` because the
   * route requires an Authorization header, which `<a>` clicks don't
   * carry.
   *
   * Memory caveat: this buffers the full response into a Blob. Fine
   * for individual files (capped 5 MB on read) and small projects.
   * For multi-GB projects swap to a service-worker-mediated download
   * — see notes in CLAUDE.md.
   */
  filesDownload: async (
    projectId: string,
    path?: string,
  ): Promise<{ blob: Blob; filename: string }> => {
    const qs = new URLSearchParams({ projectId });
    if (path !== undefined && path.length > 0) qs.set("path", path);
    const headers: Record<string, string> = {};
    const stored = getStoredToken();
    if (stored !== undefined) headers.Authorization = `Bearer ${stored.token}`;
    const res = await fetch(`/api/v1/files/download?${qs.toString()}`, { headers });
    if (res.status === 401) {
      clearStoredToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new ApiError(401, "unauthorized");
    }
    if (!res.ok) {
      let code = "request_failed";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") code = body.error;
      } catch {
        // body wasn't JSON — keep generic code
      }
      throw new ApiError(res.status, code);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") ?? "";
    return { blob, filename: parseContentDispositionFilename(cd) ?? "download" };
  },
  /**
   * Multipart upload of one or more files into `parentPath` under the
   * project. Each file's SHA-256 is hashed in the browser via WebCrypto
   * and sent as a `sha256:<filename>` field BEFORE the corresponding
   * file part — the server matches by filename and rejects with 422
   * (`checksum_mismatch`) if the bytes it wrote don't hash to the same
   * digest. Field-order matters: FormData preserves insertion order,
   * so the server can rely on field-before-file.
   */
  uploadFiles: async (
    projectId: string,
    parentPath: string,
    files: File[],
    opts?: {
      overwrite?: boolean;
      signal?: AbortSignal;
      /**
       * Called with the total bytes hashed across all files, so the
       * UI can render a "Hashing 350/500 MB" progress label. Fires
       * once per chunk (~1 MB) — coarse enough not to spam React.
       */
      onHashProgress?: (hashed: number, total: number) => void;
    },
  ): Promise<UploadResponse> => {
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("parentPath", parentPath);
    if (opts?.overwrite === true) fd.append("overwrite", "1");
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    let hashedSoFar = 0;
    for (const file of files) {
      const digest = await streamSha256(file, (delta) => {
        hashedSoFar += delta;
        opts?.onHashProgress?.(hashedSoFar, totalBytes);
      });
      fd.append(`sha256:${file.name}`, digest);
    }
    for (const file of files) {
      fd.append("files", file, file.name);
    }
    return request("/api/v1/files/upload", vUploadResponse, {
      method: "POST",
      body: fd,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  },
  /**
   * File-path autocomplete for the chat input's `@` token. Polled per
   * keystroke (server-side `logLevel: 'warn'` keeps the access logs
   * clean). Empty query returns the alphabetically-first `limit`
   * files; non-empty query path-substring matches with basename hits
   * ranked above deep-path hits.
   */
  completeFiles: (
    projectId: string,
    query: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ) => {
    const qs = new URLSearchParams({ projectId, query });
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    return request(
      `/api/v1/files/complete?${qs.toString()}`,
      (v, s) => {
        if (!isObject(v) || !Array.isArray(v.paths)) {
          fail(s, "expected { paths: string[] }");
        }
        return { paths: v.paths.filter((p): p is string => typeof p === "string") };
      },
      opts?.signal !== undefined ? { signal: opts.signal } : {},
    );
  },
  searchFiles: (projectId: string, opts: SearchOptions, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ projectId, q: opts.query });
    if (opts.regex === true) qs.set("regex", "1");
    if (opts.caseSensitive === true) qs.set("caseSensitive", "1");
    if (opts.includeGitignored === true) qs.set("includeGitignored", "1");
    if (opts.include !== undefined && opts.include.length > 0) qs.set("include", opts.include);
    if (opts.exclude !== undefined && opts.exclude.length > 0) qs.set("exclude", opts.exclude);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    return request(
      `/api/v1/files/search?${qs.toString()}`,
      vSearchResponse,
      signal !== undefined ? { signal } : {},
    );
  },

  // ---------------- git ----------------
  gitStatus: (projectId: string) =>
    request(`/api/v1/git/status?projectId=${encodeURIComponent(projectId)}`, vGitStatus),
  gitDiff: (projectId: string) =>
    request(`/api/v1/git/diff?projectId=${encodeURIComponent(projectId)}`, vGitDiff),
  gitDiffStaged: (projectId: string) =>
    request(`/api/v1/git/diff/staged?projectId=${encodeURIComponent(projectId)}`, vGitDiff),
  gitDiffFile: (projectId: string, path: string, staged: boolean) => {
    const qs = new URLSearchParams({ projectId, path });
    if (staged) qs.set("staged", "1");
    return request(`/api/v1/git/diff/file?${qs.toString()}`, vGitDiff);
  },
  gitLog: (projectId: string, limit?: number) => {
    const qs = new URLSearchParams({ projectId });
    if (limit !== undefined) qs.set("limit", String(limit));
    return request(`/api/v1/git/log?${qs.toString()}`, vGitLog);
  },
  gitBranches: (projectId: string) =>
    request(`/api/v1/git/branches?projectId=${encodeURIComponent(projectId)}`, vGitBranches),
  gitRemotes: (projectId: string) =>
    request(`/api/v1/git/remotes?projectId=${encodeURIComponent(projectId)}`, vGitRemotes),
  gitRemoteAdd: (projectId: string, name: string, url: string) =>
    request(
      "/api/v1/git/remote/add",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, name, url } },
    ),
  gitRemoteRemove: (projectId: string, name: string) =>
    request(
      `/api/v1/git/remote/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "DELETE" },
    ),
  gitCheckout: (projectId: string, branch: string) =>
    request(
      "/api/v1/git/checkout",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, branch } },
    ),
  gitBranchCreate: (
    projectId: string,
    name: string,
    opts?: { startPoint?: string; checkout?: boolean },
  ) => {
    const body: Record<string, unknown> = { projectId, name };
    if (opts?.startPoint !== undefined) body.startPoint = opts.startPoint;
    if (opts?.checkout !== undefined) body.checkout = opts.checkout;
    return request(
      "/api/v1/git/branch/create",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body },
    );
  },
  gitBranchDelete: (projectId: string, name: string, force?: boolean) => {
    const qs = new URLSearchParams({ projectId });
    if (force === true) qs.set("force", "1");
    return request(
      `/api/v1/git/branch/${encodeURIComponent(name)}?${qs.toString()}`,
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "DELETE" },
    );
  },
  gitStage: (projectId: string, paths: string[]) =>
    request(
      "/api/v1/git/stage",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, paths } },
    ),
  gitUnstage: (projectId: string, paths: string[]) =>
    request(
      "/api/v1/git/unstage",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, paths } },
    ),
  gitRevert: (projectId: string, paths: string[]) =>
    request(
      "/api/v1/git/revert",
      (v, s) => {
        if (!isObject(v) || v.ok !== true) fail(s, "expected { ok: true }");
        return { ok: true as const };
      },
      { method: "POST", body: { projectId, paths } },
    ),
  gitCommit: (projectId: string, message: string) =>
    request(
      "/api/v1/git/commit",
      (v, s) => {
        if (!isObject(v) || typeof v.hash !== "string") fail(s, "expected { hash }");
        return { hash: v.hash };
      },
      { method: "POST", body: { projectId, message } },
    ),
  gitFetch: (projectId: string, opts?: { remote?: string; prune?: boolean }) => {
    const body: Record<string, unknown> = { projectId };
    if (opts?.remote !== undefined) body.remote = opts.remote;
    if (opts?.prune !== undefined) body.prune = opts.prune;
    return request(
      "/api/v1/git/fetch",
      (v, s) => {
        if (!isObject(v) || typeof v.output !== "string") fail(s, "expected { output }");
        return { output: v.output };
      },
      { method: "POST", body },
    );
  },
  gitPull: (projectId: string, opts?: { remote?: string; branch?: string; rebase?: boolean }) => {
    const body: Record<string, unknown> = { projectId };
    if (opts?.remote !== undefined) body.remote = opts.remote;
    if (opts?.branch !== undefined) body.branch = opts.branch;
    if (opts?.rebase !== undefined) body.rebase = opts.rebase;
    return request(
      "/api/v1/git/pull",
      (v, s) => {
        if (!isObject(v) || typeof v.output !== "string") fail(s, "expected { output }");
        return { output: v.output };
      },
      { method: "POST", body },
    );
  },
  gitPush: (
    projectId: string,
    opts?: { remote?: string; branch?: string; setUpstream?: boolean },
  ) => {
    const body: Record<string, unknown> = { projectId };
    if (opts?.remote !== undefined) body.remote = opts.remote;
    if (opts?.branch !== undefined) body.branch = opts.branch;
    if (opts?.setUpstream !== undefined) body.setUpstream = opts.setUpstream;
    return request(
      "/api/v1/git/push",
      (v, s) => {
        if (!isObject(v) || typeof v.output !== "string") fail(s, "expected { output }");
        return { output: v.output };
      },
      { method: "POST", body },
    );
  },
};

// Export string validator for routes that return a bare string in future phases.
export { vString };
