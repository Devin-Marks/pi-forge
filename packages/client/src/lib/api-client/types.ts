/**
 * API client types — request/response shapes shared by the validators
 * and the `api` object. Kept as a leaf module (no runtime imports
 * beyond ApiError) so consumers can `import type` from here without
 * pulling in the request machinery.
 */

/**
 * Window event dispatched whenever an authenticated request returns 401
 * (and after the SSE reader sees a 401). The auth store subscribes to this
 * to clear `isAuthenticated` and surface the login screen. Exported so the
 * SSE reader uses the same constant — keeps the wire-name in one place.
 */
export const UNAUTHORIZED_EVENT = "pi-forge:unauthorized";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? `${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export interface AuthStatusResponse {
  authEnabled: boolean;
  ldapEnabled: boolean;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  mustChangePassword: boolean;
}

export interface ChangePasswordResponse {
  token: string;
  expiresAt: string;
  mustChangePassword: boolean;
}

// ---------------- MCP ----------------

export type McpTransport = "auto" | "streamable-http" | "sse";
export type McpConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disabled"
  | "trust_required";

export interface McpServerConfig {
  enabled?: boolean;
  // remote-only (mutually exclusive with `command`)
  url?: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  // stdio-only (mutually exclusive with `url`)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerStatus {
  scope: "global" | "project";
  projectId?: string;
  name: string;
  /** Discriminator — `remote` ↦ render `url`/`transport`; `stdio` ↦
   *  render `command`/`args`. */
  kind: "remote" | "stdio";
  /** Remote-only. Present when `kind === "remote"`. */
  url?: string;
  /** Stdio-only. */
  command?: string;
  /** Stdio-only. */
  args?: string[];
  enabled: boolean;
  state: McpConnectionState;
  toolCount: number;
  lastError?: string;
  /** Resolved remote transport — only meaningful when
   *  `kind === "remote"`. */
  transport?: McpTransport;
}

export interface McpServersResponse {
  /** GLOBAL config (project servers are read-only via /servers query). */
  servers: Record<string, McpServerConfig>;
  /** Status across global + (optionally) the queried project's scope. */
  status: McpServerStatus[];
  /** Present only when `?projectId=<id>` was passed. Reports
   *  whether this project has been granted stdio-MCP trust. */
  stdioTrust?: { trusted: boolean };
}

export interface McpSettingsResponse {
  /** Master enable/disable. When false, no MCP tools are passed to sessions. */
  enabled: boolean;
  /** Connected count across GLOBAL servers only. */
  connected: number;
  /** Total GLOBAL servers configured. */
  total: number;
}

// ---------------- processes ----------------

export type ProcessStatus = "running" | "terminating" | "terminate_timeout" | "exited" | "killed";

/**
 * Per-process snapshot. Returned by `GET /sessions/:id/processes`
 * and carried in the SSE `process_update` event's `processes`
 * array. Contract-compatible with `@aliou/pi-processes`'s
 * `ProcessInfo` shape.
 */
export interface ProcessSummary {
  id: string;
  name: string;
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  endTime: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  success: boolean | null;
  stdoutFile: string;
  stderrFile: string;
  alertOnSuccess: boolean;
  alertOnFailure: boolean;
  alertOnKill: boolean;
}

export interface ProcessesListResponse {
  processes: ProcessSummary[];
}

export interface ProcessOutputResponse {
  stdout: string[];
  stderr: string[];
  status: string;
}

export interface ProcessActionResult {
  ok: boolean;
  /** Present when `ok: false`. */
  reason?: string;
}

// ---------------- todo ----------------

export type TodoTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/**
 * Wire shape returned by `GET /sessions/:id/todos` and emitted as
 * the SSE `todo_update` event payload (without the envelope keys).
 * Contract-compatible with @juicesharp/rpiv-todo's
 * `details.{tasks, nextId}`.
 */
export interface TodoTask {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TodoTaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface TodoListResponse {
  tasks: TodoTask[];
  nextId: number;
}

// ---------------- ask_user_question ----------------

/**
 * Per-question answer envelope POSTed to
 * /sessions/:id/ask-user-question/answer. Mirrors the
 * `@juicesharp/rpiv-ask-user-question` plugin's response shape
 * so an agent prompt authored against the plugin sees the same
 * structured payload either way.
 */
export interface AskUserQuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

// ---------------- Quick actions ----------------

/**
 * Discriminator-by-presence (matches `McpServerConfig`): `command` is
 * set → command action; `text` is set → prompt action. The wire
 * surface enforces "exactly one of" with a 400 — never both, never
 * neither.
 */
export interface QuickAction {
  id: string;
  name: string;
  enabled?: boolean;
  // command-only
  command?: string;
  timeoutMs?: number;
  // prompt-only
  text?: string;
  mode?: "send" | "insert";
}

export interface QuickActionsResponse {
  actions: QuickAction[];
}

export interface QuickActionRunResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface McpToolSummary {
  name: string;
  description: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResponse {
  path: string;
  parentPath: string | null;
  entries: BrowseEntry[];
}

export interface HealthResponse {
  status: "ok";
  activeSessions: number;
  activePtys: number;
}

export const SERVER_THEME_COLOR_KEYS = [
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

export type ServerThemeColorKey = (typeof SERVER_THEME_COLOR_KEYS)[number];
export type ServerThemeColors = Record<ServerThemeColorKey, string>;

export interface ServerThemeConfigResponse {
  enabled: boolean;
  colors: ServerThemeColors;
  defaults: ServerThemeColors;
}

export interface SandboxSettingsResponse {
  enabled: boolean;
  uid?: number;
  gid?: number;
  home?: string;
  toolEnv: Record<string, string>;
}

export interface AuthColorScheme {
  pageBackground: string;
  cardBackground: string;
  border: string;
  text: string;
  mutedText: string;
  buttonBackground: string;
  buttonText: string;
  buttonHoverBackground: string;
}

export interface UiConfigResponse {
  /** Frontend "minimal" mode — see server config.minimalUi. */
  minimal: boolean;
  /** Absolute path to the workspace root, used by minimal-mode project create. */
  workspaceRoot: string;
  /** Server build version (mirrors packages/server's package.json). */
  version: string;
  /**
   * True when the server supports the browser password-change flow
   * (env UI_PASSWORD set OR a persisted password-hash exists).
   * False on API-key-only deployments — the General settings tab
   * hides the password section in that case.
   */
  passwordAuthEnabled: boolean;
  /**
   * True when the server has orchestration available (enabled by
   * default unless disabled by config) AND is NOT in MINIMAL_UI mode.
   * Controls whether the supervisor-mode toggle and Workers panel
   * render at all. Defaults to false on older servers (forward-compatible).
   */
  orchestrationEnabled: boolean;
  /** Global server-side color overrides for broad UI surfaces. */
  serverTheme: ServerThemeConfigResponse | undefined;
  /** Optional public banner shown on the login screen. */
  authBannerText: string | undefined;
  /** True when the banner should render as sanitized HTML. */
  authBannerHtml: boolean;
  /** Optional login/auth page color scheme. */
  authColorScheme: AuthColorScheme | undefined;
  /** Optional absolute http(s) URL for the login-screen logo. */
  authLogoUrl: string | undefined;
}

export interface UnifiedSession {
  sessionId: string;
  projectId: string;
  isLive: boolean;
  name?: string;
  workspacePath: string;
  lastActivityAt: string;
  createdAt: string;
  messageCount: number;
  firstMessage: string;
  /**
   * Set when this session should be nested under another session —
   * pi-subagents children use their parent session id; orchestration
   * workers use their supervisor/orchestrator session id. The sidebar
   * groups children under their parent in a chevron dropdown.
   */
  parentSessionId?: string;
  /** pi-subagents run id when this is a child session. */
  runId?: string;
  /** True when pi-subagents status.json says this child is queued/running externally. */
  isExternalLive?: boolean;
  /** Authoritative pi-subagents async status state when known. */
  externalState?: "queued" | "running" | "complete" | "failed" | "paused";
  /**
   * Absolute disk path to the session JSONL. Set for disk-discovered
   * sessions; undefined for live-only sessions that haven't flushed
   * to disk yet. The SubagentResultCard uses this to resolve a
   * `sessionFile` reference from a tool result back to the canonical
   * sessionId — pi-subagents children are named `session.jsonl`, so
   * deriving the id from the basename is unreliable.
   */
  path?: string;
}

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SessionSummary {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  createdAt: string;
  lastActivityAt: string;
  isLive: boolean;
  name?: string;
  messageCount: number;
  isStreaming: boolean;
  /**
   * Active thinking level on the live AgentSession. Only set for live
   * sessions — disk-only entries omit it because the SDK only surfaces
   * the active value on a loaded session. Loose `string` typing matches
   * the wire shape (server validates against the enum); callers that
   * want the discriminated union should narrow at use site.
   */
  thinkingLevel?: string;
  /**
   * Active model identity (`session.model.provider` / `session.model.id`)
   * on the live AgentSession. Used by the chat-input thinking-level
   * picker to resolve "what model is this session actually using" when
   * the user has no per-session override — without it, the client
   * would fall back to settings.json's defaultProvider/defaultModel,
   * which can be empty when the SDK is running on its own compile-time
   * default and would hide the thinking picker. Only set for live
   * sessions.
   */
  modelProvider?: string;
  modelId?: string;
}

export type SkillOverrideState = "enabled" | "disabled";

export interface SkillSummary {
  name: string;
  description: string;
  source: "global" | "project" | "extension";
  filePath: string;
  /** Path of the extension that contributed this skill (only when source === "extension"). */
  extensionPath?: string;
  /** Global enable from pi's settings.skills. */
  enabled: boolean;
  /** Tri-state per-project override; absent = inherit from global. */
  projectOverride?: SkillOverrideState;
  /** Resolved state for the project the request asked about. */
  effective: boolean;
  disableModelInvocation: boolean;
}

export interface SkillOverridesResponse {
  /** Map from projectId → that project's overrides. */
  projects: Record<string, { enable: string[]; disable: string[] }>;
}

/**
 * SDK-emitted diagnostic for a skill file the loader rejected.
 * Surfaced through `GET /config/skills` so the SkillsTab can show
 * the user *why* a file under `.pi/skills/` didn't load. The most
 * common case is `type: "collision"` when a top-level `<dir>/foo.md`
 * lacks `name:` frontmatter and falls back to the parent dir name,
 * colliding with another file's identical fallback.
 */
export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
  collision?: {
    resourceType: string;
    name: string;
    winnerPath: string;
    loserPath: string;
  };
}

export interface SkillsListResponse {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

// ---------------- Prompts ----------------
//
// Mirrors the Skills shapes above. Pi prompts have no
// package-contributed source today — every prompt is global or
// project — so `source` enum is narrower than skills' (no
// "extension"). `argumentHint` carries the optional bash-style
// usage hint from the prompt's frontmatter so the slash-command
// palette can render it.

export type PromptOverrideState = "enabled" | "disabled";

export interface PromptSummary {
  name: string;
  description: string;
  argumentHint?: string;
  source: "global" | "project";
  filePath: string;
  enabled: boolean;
  projectOverride?: PromptOverrideState;
  effective: boolean;
}

export interface PromptOverridesResponse {
  projects: Record<string, { enable: string[]; disable: string[] }>;
}

export interface PromptsListResponse {
  prompts: PromptSummary[];
  /** Always `[]` from the server today (prompts SDK doesn't surface
   *  collisions); kept on the shape for parallelism with skills. */
  diagnostics: SkillDiagnostic[];
}

/**
 * Unified tool listing returned by `GET /api/v1/config/tools`.
 * Two families:
 *   - `builtin` — pi's seven shipped coding tools (read, bash, edit,
 *     write, grep, find, ls). Names are bare.
 *   - `mcp` — one entry per connected MCP server, each with the tools
 *     it exposes. The tool `name` is the bridged form pi sees on the
 *     wire (`<server>__<tool>`); `shortName` is the unprefixed name
 *     the MCP server itself reports.
 *
 * Per-tool fields:
 *   - `enabled` is the EFFECTIVE state for the active project (or
 *     global state when no `projectId` was passed in the query).
 *   - `globalEnabled` is the underlying global state regardless of
 *     any project override — surfaces the "Global: enabled" label
 *     in the UI alongside the per-project tri-state.
 *   - `projectOverride` is the active project's tri-state position:
 *     `"enabled"` (project explicitly enables), `"disabled"`
 *     (project explicitly disables), or absent (inherit global).
 *     Only present when the request included `?projectId=`.
 */
export interface ToolListingItem {
  name: string;
  description: string;
  enabled: boolean;
  globalEnabled: boolean;
  projectOverride?: "enabled" | "disabled";
}
export interface ToolListing {
  builtin: ToolListingItem[];
  mcp: {
    server: string;
    scope: "global" | "project";
    projectId?: string;
    /** The MCP server's own master enable flag (from mcp.json). */
    enabled: boolean;
    state: McpConnectionState;
    lastError?: string;
    tools: (ToolListingItem & { shortName: string })[];
  }[];
  /**
   * Pi-package extension tools, grouped by the package source name
   * (e.g. `"pi-subagents"`, a git URL). The package source comes from
   * `DefaultPackageManager.resolve()` metadata and is the user-facing
   * identifier. Each tool entry carries the same enable/global/
   * projectOverride shape as the other families. Empty array on
   * deployments with no packages installed.
   */
  extension: {
    packageSource: string;
    tools: ToolListingItem[];
  }[];
}

/**
 * Cascade view returned by `GET /api/v1/config/tools/overrides`.
 * Maps projectId → that project's per-family explicit overrides.
 * Same shape as `SkillOverridesResponse` but split per family.
 * Mostly consumed by the Settings UI's per-tool expand-and-show-
 * all-projects affordance.
 */
export interface ToolOverridesResponse {
  projects: Record<
    string,
    {
      builtin: { enable: string[]; disable: string[] };
      mcp: { enable: string[]; disable: string[] };
      extension: { enable: string[]; disable: string[] };
    }
  >;
}

export interface ProviderModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  hasAuth: boolean;
  /**
   * Per-model list of thinking levels the SDK reports as supported
   * (via `getSupportedThinkingLevels(model)` on the server). Always at
   * least `["off"]`; non-reasoning models return only that. Picker
   * reads this directly — no hardcoded list — so models with `xhigh`
   * surface it and models that explicitly opt out of `low` (or any
   * other level) hide it.
   */
  supportedThinkingLevels: ModelThinkingLevel[];
}

export interface ProvidersListing {
  providers: { provider: string; models: ProviderModelEntry[] }[];
}

export interface AuthSummary {
  providers: Record<string, { configured: boolean; source?: string; label?: string }>;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
  truncated?: boolean;
}

export interface FileReadResponse {
  path: string;
  content: string;
  size: number;
  language: string;
  binary: boolean;
}

export interface TurnDiffEntry {
  file: string;
  tool: "write" | "edit";
  diff: string;
  additions: number;
  deletions: number;
  isPureAddition: boolean;
}

export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "unknown";

export interface GitFileStatus {
  path: string;
  staged: boolean;
  unstaged: boolean;
  kind: GitFileStatusKind;
  code: string;
  originalPath?: string;
}

export interface GitStatus {
  isGitRepo: boolean;
  branch?: string;
  files: GitFileStatus[];
}

export interface GitDiffResponse {
  isGitRepo: boolean;
  diff: string;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
  /** Parent commit hashes — empty for the root, two for merges. */
  parents: string[];
  /** git ref decorations (e.g. "HEAD -> main", "tag: v1", "origin/main"). */
  refs: string[];
}

export interface GitLogResponse {
  isGitRepo: boolean;
  commits: GitLogEntry[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitBranchesResponse {
  isGitRepo: boolean;
  current?: string;
  branches: GitBranch[];
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  insecureTls: boolean;
}

export interface GitRemotesResponse {
  isGitRepo: boolean;
  remotes: GitRemote[];
}

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  current: boolean;
}

export interface GitWorktreesResponse {
  isGitRepo: boolean;
  worktrees: GitWorktree[];
}

export interface SearchMatch {
  /** Project-relative POSIX path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column where the match starts on that line. */
  column: number;
  /** Number of UTF-16 units the match spans (0 if unavailable). */
  length: number;
  /** Full text of the matching line, with no trailing newline. */
  lineSnippet: string;
}

export interface SearchResponse {
  engine: "ripgrep" | "node";
  matches: SearchMatch[];
  /** True when the result hit the limit and more matches exist. */
  truncated: boolean;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  includeGitignored?: boolean;
  include?: string;
  exclude?: string;
  limit?: number;
}

export interface SessionSearchMatch {
  /**
   * Zero-based index into the session snapshot's `messages` array,
   * counting only `type === "message"` JSONL lines. For un-forked
   * sessions this maps directly to the snapshot index — the common
   * case. Forked sessions whose active branch differs from disk
   * order may not find this index; consumers should fall back to
   * `messageEnvelopeId` lookup when present.
   */
  messageIndex: number;
  /** JSONL envelope `id`, for branch-aware lookup. */
  messageEnvelopeId?: string;
  kind: "user" | "assistant" | "tool_call";
  /** ~120 chars centered on the match, with leading / trailing "…" when clipped. */
  snippet: string;
  /** Offset of the matched substring within `snippet`. */
  matchOffset: number;
  matchLength: number;
}

export interface SessionSearchGroup {
  sessionId: string;
  projectId: string;
  projectName: string;
  /** Display name from session_info; absent for unnamed sessions. */
  sessionName?: string;
  /** ISO 8601 — file mtime, used to sort newest-first. */
  modifiedAt: string;
  matches: SessionSearchMatch[];
}

export interface SessionSearchResponse {
  engine: "ripgrep" | "node";
  truncated: boolean;
  results: SessionSearchGroup[];
}

export interface SessionTreeEntry {
  id: string;
  parentId: string | null;
  /** SDK entry type — "message", "thinking_level_change", "compaction", "branch_summary", etc. */
  type: string;
  timestamp: string;
  /** Set on `type === "message"` entries. */
  role?: string;
  /** Truncated text preview (≤200 chars). Set on text-bearing message entries. */
  preview?: string;
  /** User-supplied bookmark label, if present. */
  label?: string;
}

export interface ContextTurn {
  /** Index into the messages array of this assistant turn. */
  index: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Cost in USD for this turn (sum of per-token costs). */
  cost: number;
  model: string;
  provider: string;
  /** Unix epoch ms. */
  timestamp: number;
  stopReason?: string;
}

export interface ContextUsageStats {
  /** Total context window the model supports (max input tokens). */
  contextWindow: number;
  /** Estimated current context tokens, omitted when SDK reports unknown. */
  tokens?: number;
  /** Usage as fraction of contextWindow (0..1), omitted when unknown. */
  percent?: number;
}

export interface SessionContextResponse {
  /** Full message array as the LLM sees it (post-compaction). */
  messages: Record<string, unknown>[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Sum of input + output + cache reads + cache writes across every turn. */
  totalTokens: number;
  /** Cumulative USD cost across every turn. */
  totalCost: number;
  /** Per-turn breakdown derived from each AssistantMessage.usage. */
  turns: ContextTurn[];
  contextUsage: ContextUsageStats;
}

export interface SessionTreeResponse {
  /** Current leaf id of the session — the active branch tip. */
  leafId: string | null;
  /** Entry ids on the active branch path, root → leaf. Used for highlighting. */
  branchIds: string[];
  /** Every entry across every branch. Build the tree client-side via parentId. */
  entries: SessionTreeEntry[];
}

export interface UploadedFile {
  /** Absolute path the file was written to. */
  path: string;
  size: number;
  /** Lowercase hex SHA-256 of the bytes the server actually wrote. */
  sha256: string;
}

export interface UploadResponse {
  files: UploadedFile[];
}

/**
 * Internal request options for the `request()` helper. Not exported
 * via the public api-client surface; lives in types.ts so request.ts
 * doesn't have to redeclare it.
 */
export interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the auth header even if a token is present (used by login itself). */
  skipAuth?: boolean;
}

/**
 * A typed validator that asserts a runtime shape and produces a typed value
 * (or throws ApiError(status, "invalid_response_body")). Used at the
 * api-client boundary so we never `as T` server responses without checking.
 */
export type Validator<T> = (value: unknown, status: number) => T;
