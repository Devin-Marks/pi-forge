/**
 * pi-forge CLI argument parser.
 *
 * Pure module — does NOT import from `./config.js` or any other server
 * module so it can run in the bin shim BEFORE the server module loads.
 * Config reads `process.env` at import time, so flag → env writes must
 * happen before that import.
 *
 * Single source of truth: the `FLAGS` table below drives:
 *   1. argument parsing (via Node's built-in `node:util` parseArgs)
 *   2. process.env mutation (each flag maps to its env-var equivalent)
 *   3. `--help` rendering
 *
 * Adding a new env var → add one row here. Don't fork the table.
 *
 * Conventions:
 *   - Flag names: kebab-case, long-form only (no single-char shortcuts).
 *   - Boolean flags: `--foo true|false|on|off|1|0|yes|no`. Bare `--foo`
 *     is treated as `--foo=true`. `--no-foo` is treated as `--foo=false`.
 *   - Path flags: passed through verbatim (config.ts resolves them).
 *   - Sensitive flags (auth secrets): support `@<path>` syntax so the
 *     value can come from a file instead of argv (avoids shell history
 *     / `ps` exposure). Same convention `curl` and `gh` use.
 *   - Flag values always WIN over env. `pi-forge --port 4000` overrides
 *     `PORT=3000` in the environment. Env is a fallback — if the flag
 *     is absent, the existing env value persists, and config.ts handles
 *     the default.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

type FlagType = "string" | "number" | "boolean" | "list";
type FlagGroup = "network" | "paths" | "auth" | "rate-limits" | "features" | "terminal" | "sandbox";

interface FlagDef {
  name: string; // kebab-case CLI flag (without leading --)
  env: string; // process.env key it writes to
  type: FlagType;
  group: FlagGroup;
  desc: string;
  defaultText: string; // shown in --help (not the actual default — config.ts owns that)
  sensitive?: boolean; // enable @file syntax
}

const FLAGS: readonly FlagDef[] = [
  // network
  {
    name: "port",
    env: "PORT",
    type: "number",
    group: "network",
    desc: "HTTP listen port",
    defaultText: "3000",
  },
  {
    name: "host",
    env: "HOST",
    type: "string",
    group: "network",
    desc: "Bind address (loopback by default; set 0.0.0.0 to expose to the network)",
    defaultText: "127.0.0.1",
  },
  {
    name: "cors-origin",
    env: "CORS_ORIGIN",
    type: "string",
    group: "network",
    desc: "CORS allow-origin (production only; dev is wide-open)",
    defaultText: "(unset)",
  },
  {
    name: "trust-proxy",
    env: "TRUST_PROXY",
    type: "boolean",
    group: "network",
    desc: "Trust X-Forwarded-* headers (set when behind a reverse proxy)",
    defaultText: "false",
  },
  // paths
  {
    name: "workspace-path",
    env: "WORKSPACE_PATH",
    type: "string",
    group: "paths",
    desc: "Where project code lives",
    defaultText: "~/.pi-forge/workspace",
  },
  {
    name: "pi-config-dir",
    env: "PI_CONFIG_DIR",
    type: "string",
    group: "paths",
    desc: "Pi SDK config dir (auth/models/settings)",
    defaultText: "~/.pi/agent",
  },
  {
    name: "forge-data-dir",
    env: "FORGE_DATA_DIR",
    type: "string",
    group: "paths",
    desc: "Forge state dir (projects.json, mcp.json, overrides)",
    defaultText: "~/.pi-forge",
  },
  {
    name: "session-dir",
    env: "SESSION_DIR",
    type: "string",
    group: "paths",
    desc: "JSONL session storage",
    defaultText: "${workspace-path}/.pi/sessions",
  },
  {
    name: "client-dist-path",
    env: "CLIENT_DIST_PATH",
    type: "string",
    group: "paths",
    desc: "Built client (Vite output) dir",
    defaultText: "(bundled with package)",
  },
  // auth
  {
    name: "ui-password",
    env: "UI_PASSWORD",
    type: "string",
    group: "auth",
    desc: "Browser login password (enables JWT auth). Use @<path> to read from a file.",
    defaultText: "(unset, auth disabled unless --api-key)",
    sensitive: true,
  },
  {
    name: "ui-password-file",
    env: "UI_PASSWORD_FILE",
    type: "string",
    group: "auth",
    desc: "Path to browser login password file (OpenShift/Kubernetes secret mount)",
    defaultText: "(unset)",
  },
  {
    name: "local-admin-username",
    env: "FORGE_LOCAL_ADMIN_USERNAME",
    type: "string",
    group: "auth",
    desc: "Username that selects the local admin password when LDAP login is enabled",
    defaultText: "admin",
  },
  {
    name: "api-key",
    env: "API_KEY",
    type: "string",
    group: "auth",
    desc: "Static bearer token for programmatic clients. Use @<path> to read from a file.",
    defaultText: "(unset, auth disabled unless --ui-password)",
    sensitive: true,
  },
  {
    name: "jwt-secret",
    env: "JWT_SECRET",
    type: "string",
    group: "auth",
    desc: "JWT signing secret (auto-generated and persisted if unset). Use @<path>.",
    defaultText: "(auto-generated)",
    sensitive: true,
  },
  {
    name: "jwt-expires-in-seconds",
    env: "JWT_EXPIRES_IN_SECONDS",
    type: "number",
    group: "auth",
    desc: "Browser JWT lifetime in seconds",
    defaultText: "604800 (7d)",
  },
  {
    name: "login-inactivity-timeout-seconds",
    env: "LOGIN_INACTIVITY_TIMEOUT_SECONDS",
    type: "number",
    group: "auth",
    desc: "Expire browser JWTs after this many seconds without activity (0 disables)",
    defaultText: "0 (disabled)",
  },
  {
    name: "require-password-change",
    env: "REQUIRE_PASSWORD_CHANGE",
    type: "boolean",
    group: "auth",
    desc: "Require user to change password on first login (set when --ui-password is sealed-secret)",
    defaultText: "false",
  },
  {
    name: "ldap-enabled",
    env: "LDAP_ENABLED",
    type: "boolean",
    group: "auth",
    desc: "Enable LDAP username/password browser login",
    defaultText: "false",
  },
  {
    name: "ldap-url",
    env: "LDAP_URL",
    type: "string",
    group: "auth",
    desc: "LDAP server URL (ldap:// or ldaps://)",
    defaultText: "(unset)",
  },
  {
    name: "ldap-bind-dn",
    env: "LDAP_BIND_DN",
    type: "string",
    group: "auth",
    desc: "LDAP service-account bind DN used to search users",
    defaultText: "(unset)",
  },
  {
    name: "ldap-bind-password",
    env: "LDAP_BIND_PASSWORD",
    type: "string",
    group: "auth",
    desc: "LDAP service-account bind password. Use @<path> to read from a file.",
    defaultText: "(unset)",
    sensitive: true,
  },
  {
    name: "ldap-bind-password-file",
    env: "LDAP_BIND_PASSWORD_FILE",
    type: "string",
    group: "auth",
    desc: "Path to LDAP bind password file (OpenShift/Kubernetes secret mount)",
    defaultText: "(unset)",
  },
  {
    name: "ldap-base-dn",
    env: "LDAP_BASE_DN",
    type: "string",
    group: "auth",
    desc: "LDAP search base DN for users",
    defaultText: "(unset)",
  },
  {
    name: "ldap-user-filter",
    env: "LDAP_USER_FILTER",
    type: "string",
    group: "auth",
    desc: "LDAP user search filter; use {{username}} placeholder",
    defaultText: "(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))",
  },
  {
    name: "ldap-required-group-dn",
    env: "LDAP_REQUIRED_GROUP_DN",
    type: "string",
    group: "auth",
    desc: "Optional required group DN checked against memberOf",
    defaultText: "(unset)",
  },
  {
    name: "ldap-group-attribute",
    env: "LDAP_GROUP_ATTRIBUTE",
    type: "string",
    group: "auth",
    desc: "LDAP user attribute containing group DNs",
    defaultText: "memberOf",
  },
  {
    name: "ldap-timeout-ms",
    env: "LDAP_TIMEOUT_MS",
    type: "number",
    group: "auth",
    desc: "LDAP connect/operation timeout (ms)",
    defaultText: "5000",
  },
  {
    name: "ldap-tls-reject-unauthorized",
    env: "LDAP_TLS_REJECT_UNAUTHORIZED",
    type: "boolean",
    group: "auth",
    desc: "Reject untrusted LDAP TLS certificates; set false only for local/self-signed testing",
    defaultText: "true",
  },
  // features
  {
    name: "log-level",
    env: "LOG_LEVEL",
    type: "string",
    group: "features",
    desc: "Pino log level: trace|debug|info|warn|error|fatal",
    defaultText: "info",
  },
  {
    name: "serve-client",
    env: "SERVE_CLIENT",
    type: "boolean",
    group: "features",
    desc: "Serve the built React UI from this server (turn off if running Vite separately)",
    defaultText: "true",
  },
  {
    name: "minimal-ui",
    env: "MINIMAL_UI",
    type: "boolean",
    group: "features",
    desc: "Hide terminal/git/last-turn/settings panes; locked-down deploys",
    defaultText: "false",
  },
  {
    name: "auth-banner-text",
    env: "AUTH_BANNER_TEXT",
    type: "string",
    group: "features",
    desc: "Optional public banner shown below the login prompt (supports \\n/\\r escapes)",
    defaultText: "(unset)",
  },
  {
    name: "auth-banner-html",
    env: "AUTH_BANNER_HTML",
    type: "boolean",
    group: "features",
    desc: "Render auth banner as sanitized HTML instead of plain text",
    defaultText: "false",
  },
  {
    name: "auth-logo-url",
    env: "AUTH_LOGO_URL",
    type: "string",
    group: "features",
    desc: "Absolute http(s) URL for the login-screen logo",
    defaultText: "(unset)",
  },
  {
    name: "auth-color-scheme",
    env: "AUTH_COLOR_SCHEME",
    type: "string",
    group: "features",
    desc: "Login/auth page colors: page,card,border,text,muted,button,button-text,button-hover",
    defaultText: "(unset)",
  },
  {
    name: "hide-builtin-providers",
    env: "HIDE_BUILTIN_PROVIDERS",
    type: "boolean",
    group: "features",
    desc: "Hide built-in provider entries from the providers list",
    defaultText: "false",
  },
  {
    name: "expose-docs",
    env: "EXPOSE_DOCS",
    type: "boolean",
    group: "features",
    desc: "Expose /api/docs (Swagger UI + OpenAPI JSON)",
    defaultText: "true",
  },
  {
    name: "disable-orchestration",
    env: "ORCHESTRATION_DISABLED",
    type: "boolean",
    group: "features",
    desc: "Disable session orchestration (enabled by default unless MINIMAL_UI is set)",
    defaultText: "false",
  },
  {
    name: "orchestration-enabled",
    env: "ORCHESTRATION_ENABLED",
    type: "boolean",
    group: "features",
    desc: "Compatibility alias: set false (or --no-orchestration-enabled) to disable orchestration",
    defaultText: "true",
  },
  {
    name: "orchestration-max-workers-per-supervisor",
    env: "ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR",
    type: "number",
    group: "features",
    desc: "Per-supervisor live-worker cap for session orchestration",
    defaultText: "8",
  },
  {
    name: "agent-secret-hygiene",
    env: "AGENT_SECRET_HYGIENE_RULE",
    type: "boolean",
    group: "features",
    desc: "Append a secret-hygiene rule to the agent's system prompt",
    defaultText: "false",
  },
  // sandbox
  {
    name: "agent-tool-sandbox-enabled",
    env: "AGENT_TOOL_SANDBOX_ENABLED",
    type: "boolean",
    group: "sandbox",
    desc: "Run model/user shell surfaces as restricted UID/GID with path-scoped file tools",
    defaultText: "false",
  },
  {
    name: "agent-tool-uid",
    env: "AGENT_TOOL_UID",
    type: "number",
    group: "sandbox",
    desc: "Numeric UID for sandboxed model/user shell processes",
    defaultText: "(required when sandbox enabled)",
  },
  {
    name: "agent-tool-gid",
    env: "AGENT_TOOL_GID",
    type: "number",
    group: "sandbox",
    desc: "Numeric GID for sandboxed model/user shell processes",
    defaultText: "(required when sandbox enabled)",
  },
  {
    name: "agent-tool-home",
    env: "AGENT_TOOL_HOME",
    type: "string",
    group: "sandbox",
    desc: "Writable HOME for sandboxed model/user shell processes",
    defaultText: "/home/pi-tools",
  },
  {
    name: "agent-tool-sandbox-chown-paths",
    env: "AGENT_TOOL_SANDBOX_CHOWN_PATHS",
    type: "list",
    group: "sandbox",
    desc: "Existing paths to recursively chown to the sandbox UID:GID at startup",
    defaultText: "(empty)",
  },
  // rate limits
  {
    name: "rate-limit-login-max",
    env: "RATE_LIMIT_LOGIN_MAX",
    type: "number",
    group: "rate-limits",
    desc: "Login attempts per window",
    defaultText: "10",
  },
  {
    name: "rate-limit-login-window-ms",
    env: "RATE_LIMIT_LOGIN_WINDOW_MS",
    type: "number",
    group: "rate-limits",
    desc: "Login rate-limit window (ms)",
    defaultText: "60000",
  },
  {
    name: "rate-limit-prompt-max",
    env: "RATE_LIMIT_PROMPT_MAX",
    type: "number",
    group: "rate-limits",
    desc: "Prompt/steer/compact/navigate calls per window",
    defaultText: "60",
  },
  {
    name: "rate-limit-prompt-window-ms",
    env: "RATE_LIMIT_PROMPT_WINDOW_MS",
    type: "number",
    group: "rate-limits",
    desc: "Prompt rate-limit window (ms)",
    defaultText: "60000",
  },
  {
    name: "rate-limit-upload-max",
    env: "RATE_LIMIT_UPLOAD_MAX",
    type: "number",
    group: "rate-limits",
    desc: "File upload calls per window",
    defaultText: "30",
  },
  {
    name: "rate-limit-upload-window-ms",
    env: "RATE_LIMIT_UPLOAD_WINDOW_MS",
    type: "number",
    group: "rate-limits",
    desc: "Upload rate-limit window (ms)",
    defaultText: "60000",
  },
  {
    name: "rate-limit-search-max",
    env: "RATE_LIMIT_SEARCH_MAX",
    type: "number",
    group: "rate-limits",
    desc: "File search calls per window",
    defaultText: "60",
  },
  {
    name: "rate-limit-search-window-ms",
    env: "RATE_LIMIT_SEARCH_WINDOW_MS",
    type: "number",
    group: "rate-limits",
    desc: "Search rate-limit window (ms)",
    defaultText: "60000",
  },
  {
    name: "rate-limit-push-max",
    env: "RATE_LIMIT_PUSH_MAX",
    type: "number",
    group: "rate-limits",
    desc: "Git push calls per window",
    defaultText: "10",
  },
  {
    name: "rate-limit-push-window-ms",
    env: "RATE_LIMIT_PUSH_WINDOW_MS",
    type: "number",
    group: "rate-limits",
    desc: "Push rate-limit window (ms)",
    defaultText: "60000",
  },
  // terminal
  {
    name: "pty-idle-reap-ms",
    env: "PTY_IDLE_REAP_MS",
    type: "number",
    group: "terminal",
    desc: "How long a detached PTY survives before reap (ms; 0 disables reattach)",
    defaultText: "600000 (10m)",
  },
  {
    name: "terminal-ws-keepalive-ms",
    env: "TERMINAL_WS_KEEPALIVE_MS",
    type: "number",
    group: "terminal",
    desc: "WebSocket ping cadence for idle integrated terminals (ms; 0 disables)",
    defaultText: "30000 (30s)",
  },
  {
    name: "terminal-passthrough-env",
    env: "TERMINAL_PASSTHROUGH_ENV",
    type: "list",
    group: "terminal",
    desc: "Extra env vars the integrated terminal inherits (comma- or space-separated)",
    defaultText: "(empty allowlist)",
  },
] as const;

const FLAGS_BY_NAME = new Map(FLAGS.map((f) => [f.name, f]));

const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);

export interface ParseResult {
  /** Env writes to apply, in declaration order. */
  envWrites: { key: string; value: string }[];
  /** True if --help was passed. */
  helpRequested: boolean;
  /** True if --version / -v was passed. */
  versionRequested: boolean;
  /** Errors collected during parsing. Bin shim should print + exit 2 if non-empty. */
  errors: string[];
  /** Positional args after flags (rejected with an error today; reserved for future subcommands). */
  positionals: string[];
}

/**
 * Pre-process argv to handle `--no-<bool>` (parseArgs doesn't natively).
 *
 * `--no-foo` becomes `--foo=false` (only for declared boolean flags;
 * unknown `--no-X` is left untouched so parseArgs surfaces it as a
 * normal "Unknown option" error).
 */
function expandNegatedBooleans(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--no-")) {
      const name = arg.slice("--no-".length);
      const def = FLAGS_BY_NAME.get(name);
      if (def && def.type === "boolean") {
        out.push(`--${name}=false`);
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/** Read a sensitive flag's value, dereferencing `@<path>` syntax. */
function resolveSensitive(value: string, flagName: string, errors: string[]): string | undefined {
  if (!value.startsWith("@")) return value;
  const path = value.slice(1);
  if (path === "") {
    errors.push(`--${flagName}: @ syntax requires a path (e.g. --${flagName} @/run/secrets/key)`);
    return undefined;
  }
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    errors.push(
      `--${flagName}: failed to read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    );
    return undefined;
  }
}

export function parseCliArgs(argv: string[]): ParseResult {
  const result: ParseResult = {
    envWrites: [],
    helpRequested: false,
    versionRequested: false,
    errors: [],
    positionals: [],
  };

  const expanded = expandNegatedBooleans(argv);

  // parseArgs option config — booleans are `type: "string"` so we can
  // accept BOTH `--foo` (bare) and `--foo true|false` uniformly. We
  // post-process the value in our own bool-coercion step.
  interface ParseArgsOpt {
    type: "string" | "boolean";
    multiple?: boolean;
    short?: string;
  }
  const options: Record<string, ParseArgsOpt> = {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  };
  for (const f of FLAGS) {
    if (f.type === "boolean") {
      // Accept bare `--foo` (parsed as boolean true) and `--foo=value` (string).
      // parseArgs can't represent both — pick string, treat presence-without-value
      // by inserting "=true" in pre-pass.
      options[f.name] = { type: "string" };
    } else {
      options[f.name] = { type: "string" };
    }
  }

  // Second pre-pass: bare `--bool-flag` with no following arg (or a
  // following arg that looks like another flag) → `--bool-flag=true`.
  // Otherwise we leave it alone so parseArgs grabs the next arg as the
  // value, and the bool-coercion step below produces a precise
  // "expected a boolean" error rather than a generic "unexpected
  // positional" complaint.
  const finalArgs: string[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--") && !arg.includes("=")) {
      const name = arg.slice(2);
      const def = FLAGS_BY_NAME.get(name);
      if (def && def.type === "boolean") {
        const next = expanded[i + 1];
        if (next === undefined || next.startsWith("--") || next.startsWith("-")) {
          finalArgs.push(`--${name}=true`);
          continue;
        }
      }
    }
    finalArgs.push(arg);
  }

  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: finalArgs,
      options,
      allowPositionals: true,
      strict: true,
    }) as typeof parsed;
  } catch (err) {
    result.errors.push((err as Error).message);
    return result;
  }

  result.positionals = parsed.positionals;
  if (parsed.values.help === true) result.helpRequested = true;
  if (parsed.values.version === true) result.versionRequested = true;

  if (parsed.positionals.length > 0) {
    result.errors.push(
      `Unexpected positional argument(s): ${parsed.positionals.join(", ")}. ` +
        `pi-forge takes flags only — see --help.`,
    );
  }

  const sandboxRaw =
    parsed.values["agent-tool-sandbox-enabled"] ?? process.env.AGENT_TOOL_SANDBOX_ENABLED;
  const sandboxEnabled =
    sandboxRaw !== undefined && BOOL_TRUE.has(String(sandboxRaw).toLowerCase());
  const ldapBindPasswordRaw = parsed.values["ldap-bind-password"];
  if (
    sandboxEnabled &&
    typeof ldapBindPasswordRaw === "string" &&
    ldapBindPasswordRaw.startsWith("@")
  ) {
    result.errors.push(
      "LDAP bind password file references are not allowed when AGENT_TOOL_SANDBOX_ENABLED=true. Use an environment variable value or external secret broker.",
    );
  }
  if (sandboxEnabled && parsed.values["ldap-bind-password-file"] !== undefined) {
    result.errors.push(
      "LDAP bind password file references are not allowed when AGENT_TOOL_SANDBOX_ENABLED=true. Use an environment variable value or external secret broker.",
    );
  }

  for (const f of FLAGS) {
    const raw = parsed.values[f.name];
    if (raw === undefined) continue;
    const rawStr = String(raw);

    if (f.type === "boolean") {
      const lc = rawStr.toLowerCase();
      if (BOOL_TRUE.has(lc)) {
        result.envWrites.push({ key: f.env, value: "true" });
      } else if (BOOL_FALSE.has(lc)) {
        result.envWrites.push({ key: f.env, value: "false" });
      } else {
        result.errors.push(
          `--${f.name}: expected a boolean (true/false/on/off/1/0/yes/no), got ${JSON.stringify(rawStr)}`,
        );
      }
      continue;
    }

    if (f.type === "number") {
      const n = Number.parseInt(rawStr, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== rawStr.trim()) {
        result.errors.push(
          `--${f.name}: expected a non-negative integer, got ${JSON.stringify(rawStr)}`,
        );
        continue;
      }
      result.envWrites.push({ key: f.env, value: String(n) });
      continue;
    }

    if (f.sensitive) {
      const resolved = resolveSensitive(rawStr, f.name, result.errors);
      if (resolved === undefined) continue;
      if (resolved === "") {
        result.errors.push(`--${f.name}: resolved value is empty`);
        continue;
      }
      result.envWrites.push({ key: f.env, value: resolved });
      continue;
    }

    // string + list pass through verbatim — config.ts parses lists.
    result.envWrites.push({ key: f.env, value: rawStr });
  }

  return result;
}

/**
 * Apply parsed env writes. Flag values WIN over any pre-existing env,
 * matching the documented "flag overrides env" rule.
 */
export function applyCliEnv(parsed: ParseResult): void {
  for (const { key, value } of parsed.envWrites) {
    process.env[key] = value;
  }
}

const GROUP_LABELS: Record<FlagGroup, string> = {
  network: "Network",
  paths: "Paths",
  auth: "Authentication",
  features: "Features",
  sandbox: "Agent tool sandbox",
  "rate-limits": "Rate limits",
  terminal: "Terminal",
};

export function buildHelpText(version: string): string {
  const out: string[] = [];
  out.push(`pi-forge ${version}`);
  out.push("");
  out.push("Browser UI for the pi coding agent.");
  out.push("");
  out.push("Usage:");
  out.push("  pi-forge [options]");
  out.push("");
  out.push(
    "Every option below has an equivalent environment variable. Flags win when both are set.",
  );
  out.push("");

  const groups: FlagGroup[] = [
    "network",
    "paths",
    "auth",
    "features",
    "sandbox",
    "rate-limits",
    "terminal",
  ];
  for (const group of groups) {
    const flags = FLAGS.filter((f) => f.group === group);
    if (flags.length === 0) continue;
    out.push(`${GROUP_LABELS[group]}:`);
    const longest = Math.max(...flags.map((f) => f.name.length + (f.type === "boolean" ? 0 : 6)));
    for (const f of flags) {
      const flagCol = f.type === "boolean" ? `--${f.name}` : `--${f.name} <val>`;
      const padded = flagCol.padEnd(longest + 4, " ");
      out.push(`  ${padded}${f.desc}`);
      out.push(`  ${"".padEnd(longest + 4, " ")}env: ${f.env}; default: ${f.defaultText}`);
    }
    out.push("");
  }

  out.push("Other:");
  out.push("  --help, -h          Show this help and exit");
  out.push("  --version, -v       Print version and exit");
  out.push("");
  out.push("Boolean flags accept true/false/on/off/1/0/yes/no, or use --no-<flag> for false.");
  out.push(
    "Sensitive flags (--ui-password, --api-key, --jwt-secret, --ldap-bind-password) accept @<path> to read from file.",
  );
  out.push("");
  out.push("Examples:");
  out.push("  pi-forge --port 4000 --workspace-path ~/Code");
  out.push("  pi-forge --api-key @/run/secrets/api-key");
  out.push("  pi-forge --no-expose-docs --minimal-ui");
  out.push("");
  return out.join("\n");
}

/** Exposed so tests can iterate the same source of truth. */
export const FLAG_DEFS: readonly FlagDef[] = FLAGS;
