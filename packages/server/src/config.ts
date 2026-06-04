import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readEnv(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? undefined : v;
}

function readInt(key: string, fallback: number): number {
  const v = readEnv(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== v.trim()) {
    throw new Error(`config: ${key} must be a non-negative integer (got ${v})`);
  }
  return n;
}

function readOptionalInt(key: string): number | undefined {
  const v = readEnv(key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== v.trim()) {
    throw new Error(`config: ${key} must be a non-negative integer (got ${v})`);
  }
  return n;
}

function readStringList(key: string): string[] {
  const v = readEnv(key);
  if (v === undefined) return [];
  // Comma- or whitespace-separated; either is natural in shell, k8s
  // env, and docker-compose `environment:` lists. Drop empties so
  // trailing commas don't produce ghost entries.
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readSecretFile(path: string, envKey: string): string {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (value.length === 0) {
      throw new Error("file is empty");
    }
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`config: failed to read ${envKey} from file ${path}: ${message}`, {
      cause: err,
    });
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const v = readEnv(key)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`config: ${key} must be a boolean-ish value (got ${v})`);
}

function readBoundedInt(key: string, fallback: number, min: number, max: number): number {
  const v = readEnv(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function readOrchestrationEnabled(): boolean {
  if (readBool("ORCHESTRATION_DISABLED", false)) return false;
  // Backward compatibility: the old opt-in flag now only acts as a
  // disable switch when explicitly false. `true` and unset both keep
  // the new default (enabled) behavior.
  return readBool("ORCHESTRATION_ENABLED", true);
}

/**
 * Forge-owned root. `~/.pi-forge` is the single dotdir we own.
 * By default it holds both the project registry and the workspace where
 * user code lives:
 *
 *   ~/.pi-forge/
 *     ├── projects.json   ← FORGE_DATA_DIR by default
 *     └── workspace/      ← WORKSPACE_PATH by default
 *
 * Either path can be relocated independently via its env var (e.g. point
 * `WORKSPACE_PATH` at an existing `~/Code` dir to use code you already
 * have on disk). Docker compose sets both explicitly so the container
 * layout is unchanged.
 */
const HOME = homedir();
if (HOME === "/" || HOME === "") {
  throw new Error(
    `config: os.homedir() returned ${JSON.stringify(HOME)}. ` +
      "This usually means HOME / USERPROFILE is unset. " +
      "Set WORKSPACE_PATH, PI_CONFIG_DIR, and FORGE_DATA_DIR explicitly, " +
      "or run the server with a real user account.",
  );
}
const FORGE_HOME = join(HOME, ".pi-forge");
const WORKSPACE_PATH = resolve(readEnv("WORKSPACE_PATH") ?? join(FORGE_HOME, "workspace"));
// Default to the current user's home so local dev on macOS/Linux just works.
// In the documented Docker setup this still resolves to `/root/.pi/agent`
// (root's homedir IS `/root` inside the container), so the production target
// is unchanged. Override explicitly via PI_CONFIG_DIR if needed.
const PI_CONFIG_DIR = resolve(readEnv("PI_CONFIG_DIR") ?? join(HOME, ".pi", "agent"));
const SESSION_DIR = resolve(readEnv("SESSION_DIR") ?? `${WORKSPACE_PATH}/.pi/sessions`);
/**
 * Forge-owned data dir. Holds `projects.json` (the project registry
 * pi-forge layers on top of pi) and any other state that's ours, not
 * pi's. Defaults to `FORGE_HOME` (~/.pi-forge) so projects.json
 * sits next to the workspace folder. Kept SEPARATE from `PI_CONFIG_DIR`
 * (~/.pi/agent), which is owned by the pi SDK — auth.json, models.json,
 * settings.json. Dropping our state into the SDK's dir was the original
 * design and got refactored out.
 */
const FORGE_DATA_DIR = resolve(readEnv("FORGE_DATA_DIR") ?? FORGE_HOME);

/**
 * Path to the built client (Vite output). In production we serve this via
 * `@fastify/static`. The default resolves relative to the compiled server
 * file (`packages/server/dist/config.js` → `../../client/dist`), which
 * works for both the local `npm run build && node dist/index.js` flow and
 * the Docker image (which mirrors the same `packages/server/dist` +
 * `packages/client/dist` layout). Override with `CLIENT_DIST_PATH` if you
 * relocate the built assets.
 */
const CLIENT_DIST_PATH = resolve(
  readEnv("CLIENT_DIST_PATH") ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist"),
);

const UI_PASSWORD_FILE = readEnv("UI_PASSWORD_FILE");
const UI_PASSWORD = UI_PASSWORD_FILE
  ? readSecretFile(UI_PASSWORD_FILE, "UI_PASSWORD_FILE")
  : readEnv("UI_PASSWORD");
const API_KEY = readEnv("API_KEY");
const CORS_ORIGIN = readEnv("CORS_ORIGIN");
const PASSWORD_HASH_FILE = join(FORGE_DATA_DIR, "password-hash");
const AGENT_TOOL_SANDBOX_ENABLED = readBool("AGENT_TOOL_SANDBOX_ENABLED", false);
const AGENT_TOOL_UID = readOptionalInt("AGENT_TOOL_UID");
const AGENT_TOOL_GID = readOptionalInt("AGENT_TOOL_GID");
if (AGENT_TOOL_SANDBOX_ENABLED && (AGENT_TOOL_UID === undefined || AGENT_TOOL_GID === undefined)) {
  throw new Error(
    "config: AGENT_TOOL_SANDBOX_ENABLED=true requires numeric AGENT_TOOL_UID and AGENT_TOOL_GID",
  );
}
const LDAP_FILE_REFERENCE_ERROR =
  "LDAP bind password file references are not allowed when AGENT_TOOL_SANDBOX_ENABLED=true. Use an environment variable value or external secret broker.";
const LDAP_ENABLED = readBool("LDAP_ENABLED", false);
const LDAP_BIND_PASSWORD_FILE = readEnv("LDAP_BIND_PASSWORD_FILE");
const LDAP_BIND_PASSWORD_ENV = readEnv("LDAP_BIND_PASSWORD");
if (AGENT_TOOL_SANDBOX_ENABLED && LDAP_BIND_PASSWORD_FILE !== undefined) {
  throw new Error(`config: ${LDAP_FILE_REFERENCE_ERROR}`);
}
if (AGENT_TOOL_SANDBOX_ENABLED && LDAP_BIND_PASSWORD_ENV?.startsWith("@")) {
  throw new Error(`config: ${LDAP_FILE_REFERENCE_ERROR}`);
}
const LDAP_BIND_PASSWORD = LDAP_BIND_PASSWORD_FILE
  ? readSecretFile(LDAP_BIND_PASSWORD_FILE, "LDAP_BIND_PASSWORD_FILE")
  : LDAP_BIND_PASSWORD_ENV;

/**
 * Load a JWT signing key from `${FORGE_DATA_DIR}/jwt-secret`, or
 * generate-and-persist one on first boot. Treated like an SSH host key:
 * created once, persisted to the data dir (which is the PVC / bind-mount
 * in K8s and Docker), reused across restarts so issued tokens stay
 * valid. Setting `JWT_SECRET` env explicitly skips this entirely.
 *
 * Invoked when ANY browser-auth credential is in play: an env-supplied
 * `UI_PASSWORD`, LDAP login, or a previously-persisted password-hash
 * file (the latter survives env rotation, the same way jwt-secret does).
 * Without this, a deployment that booted with `UI_PASSWORD` once and
 * then dropped it after the user changed their password would be left
 * with a hash on disk but no signing key — login would 500 trying to
 * sign a JWT with `undefined`.
 */
function loadOrGenerateJwtSecret(dataDir: string): string {
  const path = join(dataDir, "jwt-secret");
  if (existsSync(path)) {
    const v = readFileSync(path, "utf8").trim();
    // 32 bytes = 256 bits ≈ 43 base64url chars. Anything shorter is
    // either truncated or hand-edited; regenerate rather than trust it.
    if (v.length >= 32) return v;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${secret}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  console.log(
    `[config] auto-generated JWT secret persisted at ${path}. ` +
      "Delete this file to rotate (logs out all browser sessions).",
  );
  return secret;
}

const JWT_SECRET =
  readEnv("JWT_SECRET") ??
  (UI_PASSWORD !== undefined || LDAP_ENABLED || existsSync(PASSWORD_HASH_FILE)
    ? loadOrGenerateJwtSecret(FORGE_DATA_DIR)
    : undefined);

export const config = Object.freeze({
  port: readInt("PORT", 3000),
  // HOST defaults to 127.0.0.1 in every mode. Binding loopback by
  // default protects against silently exposing the agent's shell +
  // filesystem to anyone on the same WiFi/VLAN/bridge — an opt-in,
  // not an opt-out. Operators who want LAN access (or container-host
  // port-forwarding to work) set `HOST=0.0.0.0` explicitly. The
  // shipped Docker image does this in its Dockerfile so the
  // documented `docker compose up` flow keeps working out of the box.
  host: readEnv("HOST") ?? "127.0.0.1",
  logLevel: readEnv("LOG_LEVEL") ?? "info",
  isTest: (readEnv("NODE_ENV") ?? "") === "test",
  trustProxy: readBool("TRUST_PROXY", false),
  workspacePath: WORKSPACE_PATH,
  piConfigDir: PI_CONFIG_DIR,
  forgeDataDir: FORGE_DATA_DIR,
  sessionDir: SESSION_DIR,
  clientDistPath: CLIENT_DIST_PATH,
  serveClient: readBool("SERVE_CLIENT", true),
  /**
   * Frontend "minimal" mode. When true, the client UI hides the
   * terminal, git pane, last-turn pane, and the providers/agent
   * settings sections, and replaces the project folder picker with
   * a name-only form that creates `<workspacePath>/<name>`. Server
   * routes are unchanged — this is purely a frontend gate exposed
   * via `GET /api/v1/ui-config`. Use case: locked-down deployments
   * where provider config is managed at the deploy level.
   */
  minimalUi: readBool("MINIMAL_UI", false),
  /**
   * When true, `GET /config/providers` filters out provider entries
   * whose name does NOT appear as a key in `models.json`. Built-in
   * providers (anthropic, openai, etc. that the SDK ships with) are
   * hidden from the Settings → Providers list, leaving only the
   * custom providers the operator added via `models.json`. Useful
   * for deployments that route every model through a single internal
   * gateway (vLLM, LiteLLM, internal proxy) and don't want users
   * picking the public providers from the UI.
   *
   * Intentionally not exposed in docker-compose / .env.example —
   * advanced env knob, document if/when it's needed widely.
   */
  hideBuiltinProviders: readBool("HIDE_BUILTIN_PROVIDERS", false),
  /**
   * Path to the forge-owned MCP server registry. Lives in the
   * data dir (not pi's config dir) because pi has no native MCP
   * support — `mcp.json` is purely a forge file, surfaced to
   * the agent via `customTools` on createAgentSession.
   */
  mcpConfigFile: join(FORGE_DATA_DIR, "mcp.json"),
  /**
   * Path to the forge-private per-project stdio-MCP trust list. Each
   * entry records that the operator has granted the named project
   * permission to declare stdio (subprocess-spawning) MCP servers in
   * its `.mcp.json`. Project-scoped stdio entries are gated by this
   * file — first time we see them in an untrusted project, we refuse
   * to spawn and the UI prompts. Global servers and remote
   * (URL-based) project servers are never gated. See
   * `mcp/stdio-trust.ts` for the threat-model framing.
   */
  mcpStdioTrustFile: join(FORGE_DATA_DIR, "mcp-stdio-trust.json"),
  /**
   * Path to the forge-private per-project skill overrides file.
   * Lives in the data dir (NOT in PI_CONFIG_DIR — pi's settings.skills
   * is global, and not in `<project>/.pi/` — the user picked
   * forge-private over team-shared so each install has its own
   * preferences without bleeding into the project tree).
   */
  skillOverridesFile: join(FORGE_DATA_DIR, "skills-overrides.json"),
  /**
   * Path to the forge-private per-tool override file. Captures
   * "user has explicitly disabled this builtin tool" and "user has
   * explicitly disabled this MCP tool" — both as flat allow-by-default
   * sets. Lives in the data dir (forge-owned; pi's SDK has no
   * native concept of per-tool toggles, this is purely a forge
   * filter applied to the `tools` allowlist passed to
   * createAgentSession).
   */
  toolOverridesFile: join(FORGE_DATA_DIR, "tool-overrides.json"),
  /**
   * Path to the forge-private per-project prompt overrides file.
   * Same shape + rationale as `skillOverridesFile` but for pi prompt
   * templates (markdown files under `<dir>/prompts/`). Pi's
   * `settings.prompts` is a flat global override-pattern list; we
   * inject project-scoped patterns at session create through the
   * SettingsManager monkey-patch in session-registry.ts (mirrors the
   * skills code path). Lives in the data dir for the same reasons
   * skill overrides do — install-private, not team-shared.
   */
  promptOverridesFile: join(FORGE_DATA_DIR, "prompts-overrides.json"),
  /**
   * Path to the forge-private per-project system-prompt addendum file.
   * Each project can store a free-form text block that is appended
   * to the agent's base system prompt (via pi's `appendSystemPrompt`
   * extension hook) for every session created in that project. Pi's
   * base prompt defines the tool-calling protocol — REPLACING it
   * would break tool use, so this is APPEND-only. Same data-dir
   * placement rationale as the other override files.
   */
  systemPromptOverridesFile: join(FORGE_DATA_DIR, "system-prompt-overrides.json"),
  /**
   * Path to the forge-private quick-actions registry. One flat JSON
   * array of "chips" the user can click from the chat-view toolbar to
   * fire either a shell command (run in the current project's cwd) or
   * a templated prompt (sent to / inserted into the active session).
   * Global (not per-project) by design — chips are the operator's
   * personal toolbox, same install-private rationale as the other
   * forge-owned files.
   */
  quickActionsFile: join(FORGE_DATA_DIR, "quick-actions.json"),
  /**
   * Instance-level session orchestration availability. Enabled by
   * default; operators disable it with `ORCHESTRATION_DISABLED=true`
   * (or, for compatibility with the historical opt-in flag,
   * `ORCHESTRATION_ENABLED=false`). MINIMAL_UI remains a separate hard
   * gate in `orchestration/config.ts`.
   */
  orchestrationEnabled: readOrchestrationEnabled(),
  orchestrationMaxWorkersPerSupervisor: readBoundedInt(
    "ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR",
    8,
    1,
    100,
  ),
  /**
   * Whether `/api/docs` (Swagger UI + OpenAPI JSON spec) is reachable.
   * Defaults to true so Docker / production deploys keep working without
   * extra config (the README quickstart documents `/api/docs`). When
   * auth is enabled, the existing token check still gates the docs;
   * when auth is disabled, the docs are an info-leak surface (route
   * catalogue, body schemas), so security-conscious operators in
   * unauthenticated public-internet deployments should set
   * `EXPOSE_DOCS=false` — though that combo is itself discouraged
   * (see SECURITY.md: never network-expose without auth + TLS).
   */
  exposeDocs: readBool("EXPOSE_DOCS", true),
  auth: Object.freeze({
    uiPassword: UI_PASSWORD,
    uiPasswordFile: UI_PASSWORD_FILE,
    jwtSecret: JWT_SECRET,
    apiKey: API_KEY,
    ldap: Object.freeze({
      enabled: LDAP_ENABLED,
      url: readEnv("LDAP_URL"),
      bindDn: readEnv("LDAP_BIND_DN"),
      bindPassword: LDAP_BIND_PASSWORD,
      bindPasswordFile: LDAP_BIND_PASSWORD_FILE,
      baseDn: readEnv("LDAP_BASE_DN"),
      userFilter:
        readEnv("LDAP_USER_FILTER") ??
        "(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))",
      requiredGroupDn: readEnv("LDAP_REQUIRED_GROUP_DN"),
      groupAttribute: readEnv("LDAP_GROUP_ATTRIBUTE") ?? "memberOf",
      timeoutMs: readInt("LDAP_TIMEOUT_MS", 5000),
      tlsRejectUnauthorized: readBool("LDAP_TLS_REJECT_UNAUTHORIZED", true),
    }),
    jwtExpiresInSeconds: readInt("JWT_EXPIRES_IN_SECONDS", 60 * 60 * 24 * 7),
    loginRateLimitMax: readInt("RATE_LIMIT_LOGIN_MAX", 10),
    loginRateLimitWindowMs: readInt("RATE_LIMIT_LOGIN_WINDOW_MS", 60_000),
    /**
     * When true and the only credential is the env-provided UI_PASSWORD
     * (no on-disk hash yet), the login response carries
     * `mustChangePassword: true` and the issued JWT is restricted —
     * the user can only call `POST /auth/change-password` until they
     * pick a new password. After the user changes it, the new password
     * is hashed and persisted to `${FORGE_DATA_DIR}/password-hash`,
     * and subsequent logins ignore the env value.
     *
     * Defaults to false: pi-forge is single-tenant and the user
     * setting `--ui-password` / `UI_PASSWORD` does so deliberately,
     * so forcing them to immediately pick a different password is
     * friction without a meaningful threat-model win. Deployments
     * that bake an initial sealed-secret password into env (helm,
     * docker-compose .env) and want the operator to swap it after
     * first login can opt back in with `--require-password-change`
     * (or `REQUIRE_PASSWORD_CHANGE=true`).
     */
    requirePasswordChange: readBool("REQUIRE_PASSWORD_CHANGE", false),
    /** Where the persisted scrypt hash lives — see auth.ts. */
    passwordHashFile: PASSWORD_HASH_FILE,
  }),
  /**
   * Per-route rate limits applied to the cost-heavy / disk-heavy / CPU-heavy
   * routes. Defaults are conservative — enough headroom for an interactive
   * user, low enough that a leaked-token spam loop hits the cap fast.
   * Operators with higher legitimate volume can raise via env.
   */
  rateLimits: Object.freeze({
    // /sessions/:id/{prompt,steer,compact,navigate} — per-user prompt
    // floor. 60 / minute = 1 / second sustained, far above interactive
    // typing speed; a runaway script gets capped in roughly 1 minute.
    promptMax: readInt("RATE_LIMIT_PROMPT_MAX", 60),
    promptWindowMs: readInt("RATE_LIMIT_PROMPT_WINDOW_MS", 60_000),
    // /files/upload — disk fill. 30 / minute keeps an attentive user
    // unblocked while capping a fill-the-disk loop.
    uploadMax: readInt("RATE_LIMIT_UPLOAD_MAX", 30),
    uploadWindowMs: readInt("RATE_LIMIT_UPLOAD_WINDOW_MS", 60_000),
    // /files/search — CPU. ripgrep walks the workspace; each search is
    // bounded by ripgrep but a tight loop still spins a CPU core.
    searchMax: readInt("RATE_LIMIT_SEARCH_MAX", 60),
    searchWindowMs: readInt("RATE_LIMIT_SEARCH_WINDOW_MS", 60_000),
    // /git/push — network amplification + rate-limited by the git remote.
    // Conservative — pushing 10x in a minute is almost always a mistake.
    pushMax: readInt("RATE_LIMIT_PUSH_MAX", 10),
    pushWindowMs: readInt("RATE_LIMIT_PUSH_WINDOW_MS", 60_000),
  }),
  corsOrigin: CORS_ORIGIN,
  /**
   * Extra env-var names the operator wants the integrated terminal
   * (and the `!` exec route) to inherit from the pi-forge process.
   *
   * The terminal env starts from a small allowlist of harmless system
   * vars (PATH, HOME, USER, SHELL, TERM, locales — see
   * `pty-manager.ts#TERMINAL_ENV_ALLOWLIST`). Everything else is
   * dropped — including provider API keys (`OPENAI_API_KEY`,
   * `AWS_ACCESS_KEY_ID`, etc.) the operator may have in their host
   * shell that would otherwise be inherited by every spawn. This
   * defaults to fail-safe: any new sensitive var the operator sets
   * is hidden from the shell unless they explicitly pass it through.
   *
   * Add specific vars here when the shell genuinely needs them
   * (e.g. `KUBECONFIG`, `EDITOR`, `OPENAI_BASE_URL` for an internal
   * proxy). Format: comma- or whitespace-separated.
   *
   * Example: `TERMINAL_PASSTHROUGH_ENV=KUBECONFIG,EDITOR,NODE_ENV`
   */
  terminalPassthroughEnv: Object.freeze(readStringList("TERMINAL_PASSTHROUGH_ENV")),
  /**
   * Opt-in: append a pi-forge-defined "secret hygiene" rule to the
   * agent's system prompt. The rule asks the model to treat env-var
   * values as credentials by default and not echo them into responses
   * or tool outputs unless explicitly asked. See
   * `agent-resource-loader.ts#FORGE_SECRET_HYGIENE_RULE` for the
   * exact wording and `SECURITY.md` for the threat-model framing
   * (behavioral nudge, not a security control).
   *
   * Default OFF. Operators who want it explicitly opt in by setting
   * `AGENT_SECRET_HYGIENE_RULE=true`. Kept opt-in (rather than
   * default-on) so the pi-forge doesn't ship invisible behavioral
   * rules that constrain the agent in ways the user never asked for.
   * Deliberately not surfaced in `docker-compose.yml` or
   * `.env.example` — this is an advanced knob, intentionally
   * discoverable only via SECURITY.md so operators meet the rule
   * the same time they meet its caveats.
   */
  agentSecretHygieneRule: readBool("AGENT_SECRET_HYGIENE_RULE", false),
  agentToolSandbox: Object.freeze({
    enabled: AGENT_TOOL_SANDBOX_ENABLED,
    uid: AGENT_TOOL_UID,
    gid: AGENT_TOOL_GID,
  }),
  /**
   * How long a detached PTY (its WebSocket closed but no replacement
   * attached yet) is held alive before being reaped. The 10-minute
   * default protects the common reattach use case: page refresh,
   * transient network blip, laptop sleep — none of those should kill
   * the user's shell.
   *
   * Operators in resource-constrained envs (kiosks, low-RAM
   * containers) can shrink this. The integration test pins it to
   * ~200 ms so the reap-on-close assertion completes within a normal
   * test budget instead of waiting 10 minutes.
   *
   * Read by `pty-manager.ts#IDLE_REAP_MS` at module load. Setting
   * this to 0 effectively disables reattach-after-WS-drop (every WS
   * close becomes a hard kill); use that deliberately or not at all.
   */
  terminalIdleReapMs: readInt("PTY_IDLE_REAP_MS", 10 * 60 * 1000),
  /**
   * Cadence for WebSocket ping frames on the integrated terminal.
   * These pings keep otherwise-idle terminals alive through common
   * reverse-proxy idle read timeouts without sending visible bytes
   * into xterm.js. Keep comfortably below nginx's 60 s default.
   */
  terminalWsKeepaliveMs: readInt("TERMINAL_WS_KEEPALIVE_MS", 30 * 1000),
} as const);

export function authEnabled(): boolean {
  return (
    config.auth.uiPassword !== undefined ||
    config.auth.apiKey !== undefined ||
    config.auth.ldap.enabled ||
    existsSync(config.auth.passwordHashFile)
  );
}

/**
 * True iff this deployment supports the browser password-change flow:
 * either an env-supplied UI_PASSWORD is in use OR a hash has already
 * been persisted from a prior change. API-key-only deployments don't
 * have a password to change, so the Settings → General password
 * section hides on them. Read by /ui-config.
 */
export function passwordAuthEnabled(): boolean {
  return config.auth.uiPassword !== undefined || existsSync(config.auth.passwordHashFile);
}
