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
  type AskUserQuestionAnswer,
  type TodoListResponse,
  type TodoTask,
  type ProcessActionResult,
  type ProcessesListResponse,
  type ProcessOutputResponse,
  type ProcessSummary,
  type QuickAction,
  type QuickActionsResponse,
  type QuickActionRunResult,
  type Project,
  type BrowseEntry,
  type BrowseResponse,
  type HealthResponse,
  type UiConfigResponse,
  type UnifiedSession,
  type SessionSummary,
  type PromptSummary,
  type SkillDiagnostic,
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
  type SessionSearchGroup,
  type SessionSearchMatch,
  type SessionSearchResponse,
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
  // `version` and `passwordAuthEnabled` are forward-compatible: older
  // servers without the fields fall through to safe defaults.
  // - version → "unknown" so the General tab still renders.
  // - passwordAuthEnabled → true so the password section still shows
  //   (the worst case is a confusing 400 on submit; better than
  //   silently hiding the form on a server that does support it).
  const version = typeof value.version === "string" ? value.version : "unknown";
  const passwordAuthEnabled =
    typeof value.passwordAuthEnabled === "boolean" ? value.passwordAuthEnabled : true;
  // Default to false on older servers — orchestration is gated by
  // an explicit env flag, so absence === disabled.
  const orchestrationEnabled =
    typeof value.orchestrationEnabled === "boolean" ? value.orchestrationEnabled : false;
  return {
    minimal: value.minimal,
    workspaceRoot: value.workspaceRoot,
    version,
    passwordAuthEnabled,
    orchestrationEnabled,
  };
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
  if (typeof value.parentSessionId === "string") out.parentSessionId = value.parentSessionId;
  if (typeof value.runId === "string") out.runId = value.runId;
  if (typeof value.path === "string") out.path = value.path;
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
  if (typeof value.thinkingLevel === "string") out.thinkingLevel = value.thinkingLevel;
  if (typeof value.modelProvider === "string") out.modelProvider = value.modelProvider;
  if (typeof value.modelId === "string") out.modelId = value.modelId;
  return out;
}

function vAccepted(value: unknown, status: number): { accepted: true } {
  if (!isObject(value) || value.accepted !== true) fail(status, "expected { accepted: true }");
  return { accepted: true };
}

function vSkillSummary(s: unknown, status: number): SkillSummary {
  if (
    !isObject(s) ||
    typeof s.name !== "string" ||
    typeof s.description !== "string" ||
    (s.source !== "global" && s.source !== "project" && s.source !== "extension") ||
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
  if (typeof s.extensionPath === "string") {
    summary.extensionPath = s.extensionPath;
  }
  if (s.projectOverride === "enabled" || s.projectOverride === "disabled") {
    summary.projectOverride = s.projectOverride;
  }
  return summary;
}

function vSkillsList(value: unknown, status: number): { skills: SkillSummary[] } {
  if (!isObject(value) || !Array.isArray(value.skills)) {
    fail(status, "expected { skills: SkillSummary[] }");
  }
  return { skills: value.skills.map((s) => vSkillSummary(s, status)) };
}

function vSkillsListWithDiagnostics(
  value: unknown,
  status: number,
): { skills: SkillSummary[]; diagnostics: SkillDiagnostic[] } {
  if (!isObject(value) || !Array.isArray(value.skills) || !Array.isArray(value.diagnostics)) {
    fail(status, "expected { skills: SkillSummary[], diagnostics: SkillDiagnostic[] }");
  }
  const diagnostics: SkillDiagnostic[] = [];
  for (const d of value.diagnostics) {
    if (
      !isObject(d) ||
      (d.type !== "warning" && d.type !== "error" && d.type !== "collision") ||
      typeof d.message !== "string"
    ) {
      // Tolerate malformed entries — drop rather than reject the whole
      // response; a stale skill diagnostic shape shouldn't break the
      // SkillsTab from rendering the (correct) skills list.
      continue;
    }
    const out: SkillDiagnostic = { type: d.type, message: d.message };
    if (typeof d.path === "string") out.path = d.path;
    if (
      isObject(d.collision) &&
      typeof d.collision.resourceType === "string" &&
      typeof d.collision.name === "string" &&
      typeof d.collision.winnerPath === "string" &&
      typeof d.collision.loserPath === "string"
    ) {
      out.collision = {
        resourceType: d.collision.resourceType,
        name: d.collision.name,
        winnerPath: d.collision.winnerPath,
        loserPath: d.collision.loserPath,
      };
    }
    diagnostics.push(out);
  }
  return {
    skills: value.skills.map((s) => vSkillSummary(s, status)),
    diagnostics,
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

function vPromptSummary(p: unknown, status: number): PromptSummary {
  if (
    !isObject(p) ||
    typeof p.name !== "string" ||
    typeof p.description !== "string" ||
    (p.source !== "global" && p.source !== "project") ||
    typeof p.filePath !== "string" ||
    typeof p.enabled !== "boolean" ||
    typeof p.effective !== "boolean"
  ) {
    fail(status, "expected PromptSummary");
  }
  const summary: PromptSummary = {
    name: p.name,
    description: p.description,
    source: p.source,
    filePath: p.filePath,
    enabled: p.enabled,
    effective: p.effective,
  };
  if (typeof p.argumentHint === "string") summary.argumentHint = p.argumentHint;
  if (p.projectOverride === "enabled" || p.projectOverride === "disabled") {
    summary.projectOverride = p.projectOverride;
  }
  return summary;
}

function vPromptsList(value: unknown, status: number): { prompts: PromptSummary[] } {
  if (!isObject(value) || !Array.isArray(value.prompts)) {
    fail(status, "expected { prompts: PromptSummary[] }");
  }
  return { prompts: value.prompts.map((p) => vPromptSummary(p, status)) };
}

function vPromptsListWithDiagnostics(
  value: unknown,
  status: number,
): { prompts: PromptSummary[]; diagnostics: SkillDiagnostic[] } {
  if (!isObject(value) || !Array.isArray(value.prompts) || !Array.isArray(value.diagnostics)) {
    fail(status, "expected { prompts: PromptSummary[], diagnostics: SkillDiagnostic[] }");
  }
  // Same diagnostic shape as skills — see vSkillsListWithDiagnostics
  // for the per-entry tolerance rationale.
  const diagnostics: SkillDiagnostic[] = [];
  for (const d of value.diagnostics) {
    if (
      !isObject(d) ||
      (d.type !== "warning" && d.type !== "error" && d.type !== "collision") ||
      typeof d.message !== "string"
    ) {
      continue;
    }
    const out: SkillDiagnostic = { type: d.type, message: d.message };
    if (typeof d.path === "string") out.path = d.path;
    if (
      isObject(d.collision) &&
      typeof d.collision.resourceType === "string" &&
      typeof d.collision.name === "string" &&
      typeof d.collision.winnerPath === "string" &&
      typeof d.collision.loserPath === "string"
    ) {
      out.collision = {
        resourceType: d.collision.resourceType,
        name: d.collision.name,
        winnerPath: d.collision.winnerPath,
        loserPath: d.collision.loserPath,
      };
    }
    diagnostics.push(out);
  }
  return {
    prompts: value.prompts.map((p) => vPromptSummary(p, status)),
    diagnostics,
  };
}

// `vPromptOverrides` shape is identical to `vSkillOverrides` (same
// `{ projects: { <pid>: { enable, disable } } }` envelope), so reuse
// the existing validator. Aliased as a separate name in the api object
// below for clarity at call sites.
const vPromptOverrides = vSkillOverrides;

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

function vQuickAction(value: unknown, status: number): QuickAction {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    fail(status, "expected QuickAction shape");
  }
  return value as unknown as QuickAction;
}

function vQuickActions(value: unknown, status: number): QuickActionsResponse {
  if (!isObject(value) || !Array.isArray(value.actions)) {
    fail(status, "expected { actions: [...] }");
  }
  return { actions: value.actions as QuickAction[] };
}

function vQuickActionRunResult(value: unknown, status: number): QuickActionRunResult {
  if (
    !isObject(value) ||
    typeof value.success !== "boolean" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.durationMs !== "number" ||
    typeof value.timedOut !== "boolean" ||
    typeof value.truncated !== "boolean"
  ) {
    fail(status, "expected QuickActionRunResult shape");
  }
  const exitCode = value.exitCode;
  return {
    success: value.success,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    stdout: value.stdout,
    stderr: value.stderr,
    durationMs: value.durationMs,
    timedOut: value.timedOut,
    truncated: value.truncated,
  };
}

function vProcessesList(value: unknown, status: number): ProcessesListResponse {
  if (!isObject(value) || !Array.isArray(value.processes)) {
    fail(status, "expected { processes: [...] }");
  }
  return { processes: value.processes as ProcessSummary[] };
}

function vProcessOutput(value: unknown, status: number): ProcessOutputResponse {
  if (
    !isObject(value) ||
    !Array.isArray(value.stdout) ||
    !Array.isArray(value.stderr) ||
    typeof value.status !== "string"
  ) {
    fail(status, "expected { stdout, stderr, status }");
  }
  return {
    stdout: value.stdout as string[],
    stderr: value.stderr as string[],
    status: value.status,
  };
}

function vProcessAction(value: unknown, status: number): ProcessActionResult {
  if (!isObject(value) || typeof value.ok !== "boolean") {
    fail(status, "expected { ok: boolean }");
  }
  const out: ProcessActionResult = { ok: value.ok };
  if (typeof value.reason === "string") out.reason = value.reason;
  return out;
}

// ---- webhooks ----

export type WebhookEvent =
  | "agent_end"
  | "ask_user_question"
  | "process_alert"
  | "auto_retry_end"
  | "compaction_end"
  | "session_created"
  | "session_deleted";

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "agent_end",
  "ask_user_question",
  "process_alert",
  "auto_retry_end",
  "compaction_end",
  "session_created",
  "session_deleted",
] as const;

export type WebhookScope = { kind: "global" } | { kind: "project"; projectId: string };

export interface WebhookConfigWire {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  scope: WebhookScope;
  enabled: boolean;
  /** True when the server has a secret stored for this webhook.
   *  The secret itself is never returned over the wire. */
  hasSecret: boolean;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  createdAt: string;
}

export interface WebhookCreateBody {
  name: string;
  url: string;
  events: WebhookEvent[];
  scope: WebhookScope;
  secret?: string;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  enabled?: boolean;
}

export type WebhookUpdateBody = Partial<WebhookCreateBody>;

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  deliveryId: string;
  event: string;
  sessionId?: string;
  projectId?: string;
  attempt: number;
  status: "delivered" | "failed" | "error";
  statusCode?: number;
  durationMs: number;
  errorPreview?: string;
  requestedAt: string;
}

function vWebhook(value: unknown, status: number): WebhookConfigWire {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    !Array.isArray(value.events) ||
    !isObject(value.scope) ||
    typeof value.enabled !== "boolean" ||
    typeof value.hasSecret !== "boolean" ||
    typeof value.createdAt !== "string"
  ) {
    fail(status, "expected webhook config");
  }
  const scope = value.scope;
  let parsedScope: WebhookScope;
  if (scope.kind === "global") parsedScope = { kind: "global" };
  else if (scope.kind === "project" && typeof scope.projectId === "string") {
    parsedScope = { kind: "project", projectId: scope.projectId };
  } else fail(status, "bad scope");
  const out: WebhookConfigWire = {
    id: value.id,
    name: value.name,
    url: value.url,
    events: (value.events as unknown[]).filter(
      (e): e is WebhookEvent =>
        typeof e === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(e),
    ),
    scope: parsedScope,
    enabled: value.enabled,
    hasSecret: value.hasSecret,
    createdAt: value.createdAt,
  };
  if (isObject(value.headers)) {
    out.headers = Object.fromEntries(
      Object.entries(value.headers).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  }
  if (value.insecureTls === true) out.insecureTls = true;
  return out;
}

function vWebhookList(value: unknown, status: number): { webhooks: WebhookConfigWire[] } {
  if (!isObject(value) || !Array.isArray(value.webhooks)) {
    fail(status, "expected { webhooks: [...] }");
  }
  return { webhooks: value.webhooks.map((w) => vWebhook(w, status)) };
}

function vDeliveryList(value: unknown, status: number): { deliveries: WebhookDelivery[] } {
  if (!isObject(value) || !Array.isArray(value.deliveries)) {
    fail(status, "expected { deliveries: [...] }");
  }
  return { deliveries: value.deliveries as WebhookDelivery[] };
}

function vTodoList(value: unknown, status: number): TodoListResponse {
  if (!isObject(value) || !Array.isArray(value.tasks) || typeof value.nextId !== "number") {
    fail(status, "expected { tasks: [...], nextId: number }");
  }
  return { tasks: value.tasks as TodoTask[], nextId: value.nextId };
}

// ---- orchestration ----

export type SessionRole = "supervisor" | "worker" | "standalone";

export interface OrchestrationConfig {
  enabled: boolean;
  maxWorkersPerSupervisor: number;
  maxDepth: number;
  /** Empty string when enabled; otherwise the disable reason. */
  disabledReason: "" | "minimal_ui_disabled" | "orchestration_disabled";
}

export interface SessionLink {
  sessionId: string;
  role: SessionRole;
  /** Worker only — supervisor's session id. */
  supervisorId?: string;
  /** Supervisor only — list of worker session ids. */
  workerIds?: string[];
  /** Supervisor only — count of inbox items not yet drained by the
   *  supervisor's LLM via orchestrate_read_inbox. */
  pendingInbox?: number;
  /** Supervisor only — ISO timestamp. */
  enabledAt?: string;
  /** Worker only — ISO timestamp. */
  spawnedAt?: string;
  /** Worker only — back-reference to handoff source. */
  spawnedFrom?: { sessionId: string; mode: "fresh" | "summary" };
}

export interface WorkerSummary {
  workerId: string;
  isLive: boolean;
  isStreaming?: boolean;
  state?: "streaming" | "idle" | "cold";
  name?: string;
  lastActivityAt?: string;
  messageCount?: number;
  projectId?: string;
  spawnedAt?: string;
  spawnedFrom?: { sessionId: string; mode: string };
}

export type InboxItemType =
  | "worker.ended"
  | "worker.ask_user"
  | "worker.auto_retry_failed"
  | "worker.process_alert"
  | "worker.deleted";

export interface InboxItemWire {
  id: string;
  type: InboxItemType;
  workerId: string;
  occurredAt: string;
  data: Record<string, unknown>;
  delivered: boolean;
}

function vOrchestrationConfig(value: unknown, status: number): OrchestrationConfig {
  if (
    !isObject(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.maxWorkersPerSupervisor !== "number" ||
    typeof value.maxDepth !== "number" ||
    typeof value.disabledReason !== "string"
  ) {
    fail(status, "expected orchestration config");
  }
  return {
    enabled: value.enabled,
    maxWorkersPerSupervisor: value.maxWorkersPerSupervisor,
    maxDepth: value.maxDepth,
    disabledReason: value.disabledReason as OrchestrationConfig["disabledReason"],
  };
}

function vSessionLink(value: unknown, status: number): SessionLink {
  if (!isObject(value) || typeof value.sessionId !== "string" || typeof value.role !== "string") {
    fail(status, "expected session link");
  }
  const role = value.role as SessionRole;
  if (role !== "supervisor" && role !== "worker" && role !== "standalone") {
    fail(status, "bad session role");
  }
  const out: SessionLink = { sessionId: value.sessionId, role };
  if (typeof value.supervisorId === "string") out.supervisorId = value.supervisorId;
  if (Array.isArray(value.workerIds)) {
    out.workerIds = value.workerIds.filter((s): s is string => typeof s === "string");
  }
  if (typeof value.pendingInbox === "number") out.pendingInbox = value.pendingInbox;
  if (typeof value.enabledAt === "string") out.enabledAt = value.enabledAt;
  if (typeof value.spawnedAt === "string") out.spawnedAt = value.spawnedAt;
  if (isObject(value.spawnedFrom) && typeof value.spawnedFrom.sessionId === "string") {
    const mode = value.spawnedFrom.mode;
    if (mode === "fresh" || mode === "summary") {
      out.spawnedFrom = { sessionId: value.spawnedFrom.sessionId, mode };
    }
  }
  return out;
}

function vWorkerSummaryList(value: unknown, status: number): { workers: WorkerSummary[] } {
  if (!isObject(value) || !Array.isArray(value.workers)) {
    fail(status, "expected { workers: [...] }");
  }
  const workers: WorkerSummary[] = [];
  for (const raw of value.workers) {
    if (!isObject(raw) || typeof raw.workerId !== "string" || typeof raw.isLive !== "boolean") {
      continue;
    }
    const w: WorkerSummary = { workerId: raw.workerId, isLive: raw.isLive };
    if (typeof raw.isStreaming === "boolean") w.isStreaming = raw.isStreaming;
    if (raw.state === "streaming" || raw.state === "idle" || raw.state === "cold") {
      w.state = raw.state;
    }
    if (typeof raw.name === "string") w.name = raw.name;
    if (typeof raw.lastActivityAt === "string") w.lastActivityAt = raw.lastActivityAt;
    if (typeof raw.messageCount === "number") w.messageCount = raw.messageCount;
    if (typeof raw.projectId === "string") w.projectId = raw.projectId;
    if (typeof raw.spawnedAt === "string") w.spawnedAt = raw.spawnedAt;
    if (
      isObject(raw.spawnedFrom) &&
      typeof raw.spawnedFrom.sessionId === "string" &&
      typeof raw.spawnedFrom.mode === "string"
    ) {
      w.spawnedFrom = { sessionId: raw.spawnedFrom.sessionId, mode: raw.spawnedFrom.mode };
    }
    workers.push(w);
  }
  return { workers };
}

function vInboxList(value: unknown, status: number): { items: InboxItemWire[] } {
  if (!isObject(value) || !Array.isArray(value.items)) {
    fail(status, "expected { items: [...] }");
  }
  const items: InboxItemWire[] = [];
  for (const raw of value.items) {
    if (
      !isObject(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.type !== "string" ||
      typeof raw.workerId !== "string" ||
      typeof raw.occurredAt !== "string" ||
      !isObject(raw.data) ||
      typeof raw.delivered !== "boolean"
    ) {
      continue;
    }
    items.push({
      id: raw.id,
      type: raw.type as InboxItemType,
      workerId: raw.workerId,
      occurredAt: raw.occurredAt,
      data: raw.data,
      delivered: raw.delivered,
    });
  }
  return { items };
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

function vSessionSearchResponse(value: unknown, status: number): SessionSearchResponse {
  if (
    !isObject(value) ||
    (value.engine !== "ripgrep" && value.engine !== "node") ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.results)
  ) {
    fail(status, "expected SessionSearchResponse");
  }
  return {
    engine: value.engine,
    truncated: value.truncated,
    results: value.results.map((g): SessionSearchGroup => {
      if (
        !isObject(g) ||
        typeof g.sessionId !== "string" ||
        typeof g.projectId !== "string" ||
        typeof g.projectName !== "string" ||
        typeof g.modifiedAt !== "string" ||
        !Array.isArray(g.matches)
      ) {
        fail(status, "expected SessionSearchGroup");
      }
      const out: SessionSearchGroup = {
        sessionId: g.sessionId,
        projectId: g.projectId,
        projectName: g.projectName,
        modifiedAt: g.modifiedAt,
        matches: g.matches.map((m): SessionSearchMatch => {
          if (
            !isObject(m) ||
            typeof m.messageIndex !== "number" ||
            (m.kind !== "user" && m.kind !== "assistant" && m.kind !== "tool_call") ||
            typeof m.snippet !== "string" ||
            typeof m.matchOffset !== "number" ||
            typeof m.matchLength !== "number"
          ) {
            fail(status, "expected SessionSearchMatch");
          }
          const match: SessionSearchMatch = {
            messageIndex: m.messageIndex,
            kind: m.kind,
            snippet: m.snippet,
            matchOffset: m.matchOffset,
            matchLength: m.matchLength,
          };
          if (typeof m.messageEnvelopeId === "string") {
            match.messageEnvelopeId = m.messageEnvelopeId;
          }
          return match;
        }),
      };
      if (typeof g.sessionName === "string") out.sessionName = g.sessionName;
      return out;
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
  reorderProjects: (ids: string[]) =>
    request("/api/v1/projects/order", vProjectList, { method: "PUT", body: { ids } }),
  deleteProject: (id: string) =>
    request(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      (v, s) => {
        if (!isObject(v) || typeof v.cascaded !== "boolean") fail(s, "expected { cascaded }");
        return { cascaded: v.cascaded };
      },
      { method: "DELETE" },
    ),
  browse: (path?: string) => {
    const qs = path !== undefined ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/v1/projects/browse${qs}`, vBrowse);
  },
  getProjectSystemPrompt: (id: string) =>
    request(
      `/api/v1/projects/${encodeURIComponent(id)}/system-prompt`,
      (v, s): { addendum: string; maxBytes: number } => {
        if (!isObject(v) || typeof v.addendum !== "string" || typeof v.maxBytes !== "number") {
          fail(s, "expected { addendum: string, maxBytes: number }");
        }
        return { addendum: v.addendum, maxBytes: v.maxBytes };
      },
    ),
  setProjectSystemPrompt: (id: string, addendum: string) =>
    request(
      `/api/v1/projects/${encodeURIComponent(id)}/system-prompt`,
      (v, s): { addendum: string; maxBytes: number } => {
        if (!isObject(v) || typeof v.addendum !== "string" || typeof v.maxBytes !== "number") {
          fail(s, "expected { addendum: string, maxBytes: number }");
        }
        return { addendum: v.addendum, maxBytes: v.maxBytes };
      },
      { method: "PUT", body: { addendum } },
    ),
  mkdir: (parentPath: string, name: string) =>
    request("/api/v1/projects/browse/mkdir", vMkdir, {
      method: "POST",
      body: { parentPath, name },
    }),
  /**
   * Start a git clone + project creation in one streaming operation.
   * Returns the raw fetch Response so callers can consume the SSE
   * stream incrementally. Server emits these event types (one JSON
   * per `data:` line):
   *   - `started`         {cloneUrlForDisplay}
   *   - `progress`        {phase, percent, raw}
   *   - `stderr`          {line}
   *   - `done`            {target} (clone finished; project not yet created)
   *   - `project_created` {project}
   *   - `error`           {code?, message}
   *
   * Not routed through `request()` because the response is a stream,
   * not a single JSON body. Caller handles parsing via
   * `parseCloneEventStream` (below) or its own line reader.
   */
  cloneProject: async (
    body: {
      url: string;
      parentPath: string;
      folderName: string;
      projectName: string;
      branch?: string;
      token?: string;
      insecureTls?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    const stored = getStoredToken();
    if (stored) headers.Authorization = `Bearer ${stored.token}`;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    if (signal !== undefined) init.signal = signal;
    const res = await fetch("/api/v1/projects/clone", init);
    if (res.status === 401) {
      clearStoredToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new ApiError(401, "invalid_token");
    }
    // Pre-stream validation failure surfaces as a normal JSON body
    // (4xx). Pass through to the caller as an ApiError so the UI can
    // show a clean error before any progress events would have
    // started.
    if (!res.ok) {
      let parsed: { error?: unknown; message?: unknown } | undefined;
      try {
        parsed = (await res.json()) as typeof parsed;
      } catch {
        /* non-JSON body */
      }
      const code = typeof parsed?.error === "string" ? parsed.error : "clone_failed";
      const msg = typeof parsed?.message === "string" ? parsed.message : undefined;
      throw new ApiError(res.status, code, msg);
    }
    return res;
  },

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
  getCompactions: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}/compactions`, (v, s) => {
      if (!isObject(v) || !Array.isArray(v.compactions)) {
        fail(s, "expected { compactions: [...] }");
      }
      return {
        compactions: v.compactions as {
          id: string;
          timestamp: string;
          summary: string;
          tokensBefore: number;
          insertBeforeIndex: number;
          archivedMessages: Record<string, unknown>[];
        }[],
      };
    }),
  disposeSession: (id: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(id)}`, vVoid, { method: "DELETE" }),
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
  // Per-session thinking-level override. Server clamps to the active
  // model's supported levels and returns the effective value — callers
  // should use the response, not the request, to update local UI state
  // so a "high" pick on a model that caps at "low" reflects accurately.
  setThinkingLevel: (id: string, level: string) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(id)}/thinking-level`,
      (v, s) => {
        if (!isObject(v) || typeof v.level !== "string") {
          fail(s, "expected { level }");
        }
        return { level: v.level };
      },
      { method: "POST", body: { level } },
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
  /** Grant this project permission to declare stdio MCP servers in
   *  its `.mcp.json`. Spawns every currently-gated entry. */
  grantStdioMcpTrust: (projectId: string) =>
    request(
      `/api/v1/mcp/trust/${encodeURIComponent(projectId)}`,
      (v, s) => {
        if (!isObject(v) || typeof v.trusted !== "boolean" || !Array.isArray(v.status)) {
          fail(s, "expected { trusted, status }");
        }
        return { trusted: v.trusted, status: v.status as McpServerStatus[] };
      },
      { method: "POST", body: {} },
    ),
  /** Revoke stdio trust + disconnect every project-scope MCP entry. */
  revokeStdioMcpTrust: (projectId: string) =>
    request(
      `/api/v1/mcp/trust/${encodeURIComponent(projectId)}`,
      (v, s) => {
        if (!isObject(v) || typeof v.trusted !== "boolean") {
          fail(s, "expected { trusted }");
        }
        return { trusted: v.trusted };
      },
      { method: "DELETE" },
    ),
  // ---------------- quick actions ----------------
  listQuickActions: () => request("/api/v1/quick-actions", vQuickActions),
  createQuickAction: (body: Omit<QuickAction, "id">) =>
    request("/api/v1/quick-actions", vQuickAction, { method: "POST", body }),
  updateQuickAction: (id: string, body: Omit<QuickAction, "id">) =>
    request(`/api/v1/quick-actions/${encodeURIComponent(id)}`, vQuickAction, {
      method: "PUT",
      body,
    }),
  deleteQuickAction: (id: string) =>
    request(`/api/v1/quick-actions/${encodeURIComponent(id)}`, vVoid, { method: "DELETE" }),
  runQuickAction: (id: string, projectId: string) =>
    request(`/api/v1/quick-actions/${encodeURIComponent(id)}/run`, vQuickActionRunResult, {
      method: "POST",
      body: { projectId },
    }),

  // ---------------- ask_user_question ----------------
  submitAskUserQuestionAnswer: (
    sessionId: string,
    body: { requestId: string; answers: AskUserQuestionAnswer[]; cancelled?: boolean },
  ) =>
    request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/ask-user-question/answer`, vVoid, {
      method: "POST",
      body,
    }),
  cancelAskUserQuestion: (sessionId: string, requestId: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/ask-user-question/answer`, vVoid, {
      method: "POST",
      body: { requestId, cancelled: true, answers: [] },
    }),

  // ---------------- todo ----------------
  listTodos: (sessionId: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/todos`, vTodoList),

  // ---------------- processes ----------------
  listProcesses: (sessionId: string) =>
    request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/processes`, vProcessesList),
  getProcessOutput: (sessionId: string, processId: string, tail?: number) => {
    const qs = tail !== undefined ? `?tail=${tail}` : "";
    return request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/output${qs}`,
      vProcessOutput,
    );
  },
  /** Returns the absolute URL of the streaming log endpoint —
   *  callers use it with EventSource or fetch+ReadableStream. */
  processLogFileUrl: (sessionId: string, processId: string, stream: "stdout" | "stderr") =>
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/logs/file?stream=${stream}`,
  killProcess: (sessionId: string, processId: string) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/kill`,
      vProcessAction,
      { method: "POST", body: {} },
    ),
  clearProcesses: (sessionId: string) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/processes`,
      (v, s) => {
        if (!isObject(v) || typeof v.cleared !== "number") {
          fail(s, "expected { cleared: number }");
        }
        return { cleared: v.cleared };
      },
      { method: "DELETE" },
    ),
  writeProcessStdin: (
    sessionId: string,
    processId: string,
    body: { input: string; end?: boolean },
  ) =>
    request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/stdin`,
      vProcessAction,
      { method: "POST", body },
    ),

  // ---------------- webhooks ----------------
  /**
   * List webhooks. Optional `projectId` filter narrows the list to
   * `(global ∪ webhooks scoped to that project)` — useful when the
   * settings UI is mounted in a project-specific view.
   */
  listWebhooks: (projectId?: string) => {
    const qs = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return request(`/api/v1/webhooks${qs}`, vWebhookList);
  },
  createWebhook: (body: WebhookCreateBody) =>
    request("/api/v1/webhooks", vWebhook, { method: "POST", body }),
  updateWebhook: (id: string, body: WebhookUpdateBody) =>
    request(`/api/v1/webhooks/${encodeURIComponent(id)}`, vWebhook, {
      method: "PATCH",
      body,
    }),
  deleteWebhook: (id: string) =>
    request(`/api/v1/webhooks/${encodeURIComponent(id)}`, vVoid, { method: "DELETE" }),
  testWebhook: (id: string) =>
    request(
      `/api/v1/webhooks/${encodeURIComponent(id)}/test`,
      (v, s) => {
        if (!isObject(v) || typeof v.queued !== "boolean") fail(s, "expected { queued }");
        return { queued: v.queued };
      },
      { method: "POST" },
    ),
  listWebhookDeliveries: (id: string) =>
    request(`/api/v1/webhooks/${encodeURIComponent(id)}/deliveries`, vDeliveryList),

  // ---------------- orchestration ----------------
  /**
   * Fetch the instance-level orchestration config — whether the
   * feature is enabled, the per-supervisor fanout cap, and (if
   * disabled) the reason. Cheap to call on every supervisor view
   * since this is purely env-derived.
   */
  orchestrationConfig: () => request("/api/v1/orchestration/config", vOrchestrationConfig),
  getSessionLink: (sessionId: string) =>
    request(`/api/v1/orchestration/sessions/${encodeURIComponent(sessionId)}`, vSessionLink),
  enableSupervisor: (sessionId: string) =>
    request(
      `/api/v1/orchestration/sessions/${encodeURIComponent(sessionId)}/enable`,
      vSessionLink,
      { method: "POST" },
    ),
  disableSupervisor: (sessionId: string) =>
    request(`/api/v1/orchestration/sessions/${encodeURIComponent(sessionId)}/disable`, vVoid, {
      method: "POST",
    }),
  listSupervisorWorkers: (sessionId: string) =>
    request(
      `/api/v1/orchestration/sessions/${encodeURIComponent(sessionId)}/workers`,
      vWorkerSummaryList,
    ),
  listSupervisorInbox: (sessionId: string) =>
    request(`/api/v1/orchestration/sessions/${encodeURIComponent(sessionId)}/inbox`, vInboxList),
  clearSupervisorInbox: (sessionId: string) =>
    request(`/api/v1/orchestration/sessions/${encodeURIComponent(sessionId)}/inbox/clear`, vVoid, {
      method: "POST",
    }),
  detachWorker: (supervisorId: string, workerId: string) =>
    request(
      `/api/v1/orchestration/sessions/${encodeURIComponent(supervisorId)}/workers/${encodeURIComponent(workerId)}/detach`,
      vVoid,
      { method: "POST" },
    ),
  killWorker: (supervisorId: string, workerId: string) =>
    request(
      `/api/v1/orchestration/sessions/${encodeURIComponent(supervisorId)}/workers/${encodeURIComponent(workerId)}/kill`,
      (v, s) => {
        if (!isObject(v) || typeof v.wasLive !== "boolean") fail(s, "expected { wasLive }");
        return { wasLive: v.wasLive };
      },
      { method: "POST" },
    ),
  resumeWorker: (supervisorId: string, workerId: string) =>
    request(
      `/api/v1/orchestration/sessions/${encodeURIComponent(supervisorId)}/workers/${encodeURIComponent(workerId)}/resume`,
      (v, s) => {
        if (!isObject(v) || typeof v.resumed !== "boolean") fail(s, "expected { resumed }");
        return { resumed: v.resumed };
      },
      { method: "POST" },
    ),

  listSkills: (projectId: string) =>
    request(
      `/api/v1/config/skills?projectId=${encodeURIComponent(projectId)}`,
      vSkillsListWithDiagnostics,
    ),
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

  // ---------------- prompts ----------------
  // Mirror of the skills surface above — see those for parameter
  // semantics and the tri-state `scope` rationale. Today the slash-
  // command palette in ChatInput drives invocation; the Settings →
  // Prompts tab uses these to render the management UI.
  listPrompts: (projectId: string) =>
    request(
      `/api/v1/config/prompts?projectId=${encodeURIComponent(projectId)}`,
      vPromptsListWithDiagnostics,
    ),
  listPromptOverrides: () => request(`/api/v1/config/prompts/overrides`, vPromptOverrides),
  setPromptEnabled: (
    projectId: string,
    name: string,
    enabled: boolean,
    scope: "global" | "project" = "global",
  ) =>
    request(
      `/api/v1/config/prompts/${encodeURIComponent(name)}/enabled?projectId=${encodeURIComponent(projectId)}`,
      vPromptsList,
      { method: "PUT", body: { enabled, scope } },
    ),
  clearPromptProjectOverride: (projectId: string, name: string) =>
    request(
      `/api/v1/config/prompts/${encodeURIComponent(name)}/enabled?projectId=${encodeURIComponent(projectId)}`,
      vPromptsList,
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
      if (
        !isObject(v) ||
        !Array.isArray(v.builtin) ||
        !Array.isArray(v.mcp) ||
        // `extension` is forward-compatible: an older server without
        // the field still parses (we coerce to []) so the client
        // doesn't error out against a stale deploy.
        (v.extension !== undefined && !Array.isArray(v.extension))
      ) {
        throw new ApiError(0, "invalid_response_body");
      }
      const out = v as unknown as ToolListing;
      if (out.extension === undefined) {
        (out as { extension: ToolListing["extension"] }).extension = [];
      }
      return out;
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
    family: "builtin" | "mcp" | "extension",
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
      // Backfill `extension: { enable: [], disable: [] }` on every
      // project entry — older servers (or servers whose response
      // schema accidentally strips the field) don't include it, and
      // the cascade UI assumes all three families are present.
      const projects = v.projects as Record<string, Record<string, unknown>>;
      for (const entry of Object.values(projects)) {
        if (entry.extension === undefined || entry.extension === null) {
          entry.extension = { enable: [], disable: [] };
        }
      }
      return v as unknown as ToolOverridesResponse;
    }),

  /** Clear a per-project tool override so the project inherits the
   *  global default. Idempotent. */
  clearToolProjectOverride: (
    family: "builtin" | "mcp" | "extension",
    name: string,
    projectId: string,
  ) =>
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
   * Export a single conversation as Markdown or raw JSONL. The server
   * inlines pi-subagents children into the parent's transcript at the
   * matching `subagent` tool call. Returns a blob + filename in the
   * same shape as exportConfig / exportSkills so the download-trigger
   * logic in the UI can stay uniform.
   */
  exportSession: async (
    sessionId: string,
    format: "markdown" | "jsonl",
  ): Promise<{ blob: Blob; filename: string }> => {
    const headers: Record<string, string> = {};
    const stored = getStoredToken();
    if (stored !== undefined) headers.Authorization = `Bearer ${stored.token}`;
    const res = await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`,
      { headers },
    );
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
    const fallback = format === "markdown" ? "session.md" : "session.jsonl";
    const filename = parseContentDispositionFilename(cd) ?? fallback;
    return { blob, filename };
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
  /**
   * Cross-session text search backed by `/api/v1/search/sessions`.
   * Used by the global search bar in the top-of-app header; returns
   * sessions grouped with per-session message snippets.
   */
  searchSessions: (
    query: string,
    opts?: { sessionLimit?: number; matchesPerSession?: number; signal?: AbortSignal },
  ) => {
    const qs = new URLSearchParams({ q: query });
    if (opts?.sessionLimit !== undefined) qs.set("sessionLimit", String(opts.sessionLimit));
    if (opts?.matchesPerSession !== undefined) {
      qs.set("matchesPerSession", String(opts.matchesPerSession));
    }
    return request(
      `/api/v1/search/sessions?${qs.toString()}`,
      vSessionSearchResponse,
      opts?.signal !== undefined ? { signal: opts.signal } : {},
    );
  },

  // ---------------- git ----------------
  gitInit: (projectId: string) =>
    request<{ alreadyInitialised: boolean; isGitRepo: boolean }>(
      `/api/v1/git/init`,
      (v, status) => {
        if (
          !isObject(v) ||
          typeof v.alreadyInitialised !== "boolean" ||
          typeof v.isGitRepo !== "boolean"
        ) {
          fail(status, "expected { alreadyInitialised, isGitRepo }");
        }
        return { alreadyInitialised: v.alreadyInitialised, isGitRepo: v.isGitRepo };
      },
      { method: "POST", body: { projectId } },
    ),
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
  /**
   * Stage or unstage selected hunks of a single file. Server returns
   * `{ ok: false, error }` for git-side failures (binary file, no diff
   * on the requested side, conflicting patch) — those are user-visible
   * events, not server errors, so the caller should branch on `ok`
   * and show the error code in a banner rather than a toast.
   */
  gitApplyHunks: (
    projectId: string,
    path: string,
    mode: "stage" | "unstage",
    hunkIndices: number[],
  ) =>
    request<{ ok: boolean; error?: string; totalHunks?: number }>(
      "/api/v1/git/apply-hunks",
      (v, s) => {
        if (!isObject(v) || typeof v.ok !== "boolean") {
          fail(s, "expected { ok: boolean }");
        }
        const out: { ok: boolean; error?: string; totalHunks?: number } = { ok: v.ok };
        if (typeof v.error === "string") out.error = v.error;
        if (typeof v.totalHunks === "number") out.totalHunks = v.totalHunks;
        return out;
      },
      { method: "POST", body: { projectId, path, mode, hunkIndices } },
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

/**
 * Wire-shape event union for the `/api/v1/projects/clone` stream.
 * Documented separately from the api.cloneProject() function so the
 * UI can switch on `event.type` with full type narrowing.
 */
export type CloneStreamEvent =
  | { type: "started"; cloneUrlForDisplay: string }
  | { type: "progress"; phase: string; percent: number | null; raw: string }
  | { type: "stderr"; line: string }
  | { type: "done"; target: string }
  | { type: "project_created"; project: Project }
  | { type: "error"; code?: string; message: string };

/**
 * Async-iterate the clone SSE response one event at a time. Same
 * frame format as the rest of the SSE surface (`data: <json>\n\n`,
 * comment lines stripped). Returns when the server closes the stream
 * or the caller aborts the underlying response.
 *
 * Errors during parsing of a single frame are swallowed (an opaque
 * `error` event with a generic message would be more confusing than
 * silently dropping a malformed frame) — but a malformed JSON in a
 * `data:` line is the only "parsing" we do; the server controls the
 * format, so this should never fire in practice.
 */
export async function* parseCloneEventStream(
  res: Response,
): AsyncGenerator<CloneStreamEvent, void, void> {
  if (res.body === null) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value.replace(/\r\n/g, "\n");
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const message = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of message.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trimStart();
          try {
            yield JSON.parse(payload) as CloneStreamEvent;
          } catch {
            /* malformed frame — drop it */
          }
        }
        sep = buf.indexOf("\n\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
