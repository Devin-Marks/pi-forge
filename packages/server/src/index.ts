import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { config, authEnabled } from "./config.js";
import { installDiagnostics } from "./diagnostics.js";
import { extractBearer, verifyApiKey, verifyToken } from "./auth.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { sessionRoutes } from "./routes/sessions.js";
import { streamRoutes } from "./routes/stream.js";
import { promptRoutes } from "./routes/prompt.js";
import { controlRoutes } from "./routes/control.js";
import { configRoutes } from "./routes/config.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { execRoutes } from "./routes/exec.js";
import { exportRoutes } from "./routes/export.js";
import { mcpRoutes } from "./routes/mcp.js";
import { quickActionRoutes } from "./routes/quick-actions.js";
import { askUserQuestionRoutes } from "./routes/ask-user-question.js";
import { todoRoutes } from "./routes/todos.js";
import { processesRoutes } from "./routes/processes.js";
import { searchRoutes } from "./routes/search.js";
import { terminalRoutes } from "./routes/terminal.js";
import { disposeAll as disposeAllMcp, loadGlobal as loadGlobalMcp } from "./mcp/manager.js";
import { initAskUserQuestionFanout, initProcessesFanout, initTodoFanout } from "./sse-bridge.js";
import { startExternalSubagentsWatcher } from "./subagents-external.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { initAskUserQuestionWebhookBridge, initProcessesWebhookBridge } from "./webhooks/init.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import {
  initOrchestrationAskUserQuestionBridge,
  initOrchestrationProcessesBridge,
} from "./orchestration/init.js";
import { disposeAllSessions } from "./session-registry.js";
import { cleanupArchivedSessions } from "./session-archive.js";
import { disposeAllPtys, installPtyExitHandler } from "./pty-manager.js";
import { logSecretHygieneState } from "./agent-resource-loader.js";
import { applySandboxStartupChowns } from "./sandbox-startup-permissions.js";

/**
 * Per-route auth metadata. Routes that should skip the auth preHandler set
 * `config.public: true` via Fastify route config. The preHandler reads the
 * matched route's config rather than maintaining a hard-coded path Set,
 * which scales as the API grows (closes the Phase 6 deferred item).
 */
declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  // Install before Fastify so unhandledRejection handlers from this
  // module are first in line — they print full cause chains for
  // errors the SDK swallows (TLS handshake failures, DNS errors,
  // ECONNREFUSED, etc.) which would otherwise surface as a terse
  // "Connection Error" with no underlying detail.
  installDiagnostics();

  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      // Scrub the `?token=...` query param from logged URLs. Browsers can't
      // attach Authorization headers to a WebSocket upgrade, so the terminal
      // route ferries its short-TTL JWT in the query string. Without this
      // serializer Fastify's default "incoming request" line logs the URL
      // verbatim, which puts the token into stdout / journald / log shippers.
      serializers: {
        req(req: FastifyRequest) {
          const url = req.url ?? "";
          const safeUrl = url.includes("token=")
            ? url.replace(/([?&])token=[^&]*/g, "$1token=REDACTED")
            : url;
          return {
            method: req.method,
            url: safeUrl,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
      // Belt-and-suspenders redaction of secret-shaped log fields. Pino's
      // redact runs across every log line (not just the `req` serializer),
      // so an operator-supplied API key in a request body — or a JWT in
      // an Authorization header that bypasses the serializer — never lands
      // in stdout / journald / log shippers in cleartext.
      //
      // Wildcard syntax (`body.providers["*"].apiKey`) follows pino's
      // documented JSONPath-lite — only key segments separated by `.` and
      // `[*]` patterns work; deeper nesting needs explicit paths.
      redact: {
        paths: [
          "headers.authorization",
          "req.headers.authorization",
          "body.password",
          "body.apiKey",
          'body.providers["*"].apiKey',
          'body.providers["*"].apiKeyCommand',
        ],
        censor: "[REDACTED]",
        remove: false,
      },
    },
    disableRequestLogging: config.isTest,
    trustProxy: config.trustProxy,
    // Phase 14 attachment uploads can be up to 8 × 10 MB = 80 MB per
    // request before the per-file `fileSize` cap fires per-part. Lift
    // Fastify's default 1 MB bodyLimit so the request reaches the
    // multipart parser, which then enforces the per-file limit and
    // marks oversize files via `file.truncated`. Pad with a little
    // headroom for boundary + field overhead.
    //
    // Memory worst case: a single request hits ~80 MB of file bytes
    // PLUS ~107 MB of base64-expanded image strings held in memory
    // before they pass to the SDK — call it ~190 MB resident. Single-
    // tenant assumption keeps this acceptable; do NOT raise the
    // bodyLimit further without revisiting `parseMultipart` to stream
    // attachments to disk instead of buffering.
    bodyLimit: 100 * 1024 * 1024,
  });

  // Purge archived sessions whose 7-day retention window has elapsed.
  // Best-effort: cleanup failures should not prevent the server from
  // starting, but they should be visible in logs.
  cleanupArchivedSessions().catch((err: unknown) => {
    fastify.log.warn({ err }, "archived session cleanup failed");
  });

  // Install the PTY exit handler — was previously fired at module-load
  // of pty-manager.ts, which made test isolation harder (every unit
  // test that imported the module also installed the handler). The
  // production server installs it explicitly here.
  installPtyExitHandler();

  await fastify.register(cors, {
    // Default to `true` (reflect request origin) so the same-origin browser
    // workflow described in the dev plan works without extra config.
    // `false` (the previous default) blocks all CORS preflights, including
    // the dev proxy. Pin to a specific origin via CORS_ORIGIN in production.
    origin: config.corsOrigin ?? true,
    credentials: false,
  });

  // Rate limiting is per-route only — no global cap by design. The login
  // route applies its own limit via route-level `config.rateLimit`.
  await fastify.register(rateLimit, { global: false });

  // Security headers — set on every response, both API and static.
  // Done as an onSend hook rather than via @fastify/helmet to avoid the
  // extra dep; the set we need is small and stable.
  //
  // CSP rationale (see also packages/client/index.html):
  //   - script-src 'self' 'wasm-unsafe-eval' — Vite's bundle plus the
  //     hash-wasm module the upload path uses for SHA-256 streaming.
  //     'wasm-unsafe-eval' permits WebAssembly.compile/instantiate ONLY;
  //     it does NOT re-enable JS eval/new Function (those still require
  //     the broader 'unsafe-eval'). Vite dev server doesn't apply our
  //     CSP, so this surfaces only on deployed instances.
  //   - style-src 'self' — Tailwind v4 emits external CSS to /assets;
  //     no inline <style> tags are rendered. We split inline-style
  //     attribute (style="...") allowance to style-src-attr so a
  //     hypothetical CSP-bypass via inline-script can't also inject
  //     a hostile <style> block.
  //   - style-src-attr 'unsafe-inline' — React's `style={{...}}` prop
  //     in RootErrorBoundary + CodeMirror's inline cursor/selection
  //     styles compile to style="..." attributes. Keep also on
  //     style-src for Safari < 15.4 which falls back to it.
  //   - img-src 'self' data: blob: — chat attachments + diff inline icons.
  //   - connect-src 'self' — same-origin only. Browsers normalize
  //     ws://same-host to the page origin, so 'self' covers the
  //     integrated terminal WS without granting open-to-any-host
  //     reach to a hypothetical bypass script.
  //   - worker-src 'self' blob: — Vite PWA service worker.
  //   - object-src 'none', base-uri 'self', frame-ancestors 'none' —
  //     defense in depth against legacy / clickjacking surfaces.
  fastify.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    // HSTS is harmless on plain HTTP (browsers ignore it without TLS),
    // useful behind a TLS proxy. 180 days is a balance: long enough to
    // matter, short enough that an operator can recover from accidentally
    // setting up HTTPS wrong.
    reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        // Keep 'unsafe-inline' on style-src for Safari < 15.4 which
        // falls back to it for inline style attributes. Newer browsers
        // honor the tighter style-src-attr below.
        "style-src 'self' 'unsafe-inline'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });

  // WebSocket support for the integrated terminal (Phase 11). Must be
  // registered before any route uses `{ websocket: true }`. Inherits
  // the same listening server as Fastify; no extra port needed.
  await fastify.register(websocket);

  // Multipart support for the prompt route's attachment handling
  // (Phase 14). Per-file cap is enforced via `limits.fileSize`; routes
  // that don't expect attachments will reject multipart with a typed
  // 415 from Fastify's content-type matching, so this register is
  // safe to apply globally.
  await fastify.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB / file — must match MAX_FILE_BYTES in routes/prompt.ts
      // Tightened from 8 → 6 after security review: the prompt route
      // accepts at most 4 images + 4 text files, so 6 is the smallest
      // cap that doesn't constrain real use (one operator may hit
      // 4-images / 2-text or vice versa). Keeps multipart parsing
      // bounded as defense in depth.
      files: 6,
      fields: 8,
    },
    attachFieldsToBody: false,
    // Default `throwFileSizeLimit: true` makes the plugin throw
    // RequestFileTooLargeError → Fastify renders a generic 413 with
    // "Payload Too Large", losing our typed error code. Set false so
    // the plugin instead marks `file.truncated: true` and lets our
    // route handler decide the response shape.
    throwFileSizeLimit: false,
  });

  await fastify.register(swagger, {
    openapi: {
      info: { title: "pi-forge API", version: "1.0.0" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  // Bootstrap script injected into the swagger UI page. Resolves an
  // auth token in priority order — URL ?token=, then sessionStorage
  // (set by an earlier visit), then localStorage["pi-forge/auth-
  // token"] (the JWT the main UI persisted on login). Same-origin so
  // the localStorage read is allowed. Then patches fetch() to attach
  // the token as a Bearer header on every call swagger UI makes to
  // /api/v1/*.
  //
  // Cleanup: if the token came from ?token=, strip it from the URL
  // via history.replaceState so it doesn't sit in the URL bar /
  // browser history. The sessionStorage stash is for in-tab nav only;
  // closing the tab clears it.
  //
  // No-op when no token is found anywhere (e.g. unauthenticated
  // visitor with auth disabled — fetch is left unpatched).
  const swaggerThemeJs = `(function () {
    try {
      var url = new URL(window.location.href);
      var qpToken = url.searchParams.get("token");
      if (qpToken && qpToken.length > 0) {
        sessionStorage.setItem("pi-forge/docs-token", qpToken);
        url.searchParams.delete("token");
        window.history.replaceState({}, document.title, url.toString());
      }
      var token =
        sessionStorage.getItem("pi-forge/docs-token") ||
        localStorage.getItem("pi-forge/auth-token");
      if (token && window.fetch) {
        var origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
          init = init || {};
          var url2 = typeof input === "string" ? input : input.url;
          if (url2 && url2.indexOf("/api/v1/") !== -1) {
            init.headers = new Headers(init.headers || {});
            if (!init.headers.has("Authorization")) {
              init.headers.set("Authorization", "Bearer " + token);
            }
          }
          return origFetch(input, init);
        };
      }
    } catch (err) {
      console.warn("pi-forge docs auth bootstrap failed:", err);
    }
  })();`;

  await fastify.register(swaggerUi, {
    routePrefix: "/api/docs",
    uiConfig: { docExpansion: "list", persistAuthorization: true },
    theme: {
      js: [{ filename: "pi-forge-auth.js", content: swaggerThemeJs }],
    },
  });

  /**
   * Auth gate. Applies to:
   *   - All `/api/v1/*` routes that are NOT marked `config.public: true`
   *     (those are health, auth/login, auth/status — see route definitions).
   *   - `/api/docs*` — the OpenAPI UI and JSON spec leak the route catalogue,
   *     so they are gated when auth is enabled. (Closes the Phase-8 deferred
   *     item.) When auth is disabled (UI_PASSWORD and API_KEY both unset),
   *     /api/docs is open — useful for local dev.
   *
   * Token check: accepts a valid JWT or a constant-time-matched API key.
   */
  fastify.addHook("onRequest", async (req, reply) => {
    const url = req.url;
    const path = url.split("?")[0] ?? url;

    // /api/docs* gating — these are not Fastify-defined routes (they're
    // injected by @fastify/swagger-ui) so we can't rely on route config.
    // Three layered checks:
    //   1. EXPOSE_DOCS=false → 404 unconditionally (production default).
    //   2. Auth disabled + EXPOSE_DOCS=true → open (dev default).
    //   3. Auth enabled → require a valid token even when docs are exposed.
    const isDocs = path === "/api/docs" || path.startsWith("/api/docs/");
    if (isDocs) {
      if (!config.exposeDocs) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      // The /api/docs static UI (HTML / JS / CSS / OpenAPI spec) is
      // open when EXPOSE_DOCS=true, regardless of auth. Browsers
      // can't attach an Authorization header on top-level
      // navigation, so gating the UI page itself on a Bearer header
      // would 401 every logged-in user who hits /api/docs from a
      // new tab. The route catalog the docs page exposes is the
      // same one this project's CLAUDE.md / repo already publish, so
      // the asset-level exposure is the same as before.
      //
      // Real protection lives at the actual API surface: every
      // /api/v1/* call swagger UI makes still goes through the
      // auth gate below. The injected theme bootstrap (see
      // swaggerThemeJs) reads the JWT/API-key out of localStorage
      // (same-origin) — or the one-shot ?token=<...> query param
      // the Settings → "API Docs ↗" button passes — and injects
      // it as a Bearer header on every fetch swagger UI issues.
      return;
    }

    if (!path.startsWith("/api/v1/")) return;

    // Route-level public marker — set on health and auth routes via
    // schema/config (see those route files).
    const routeConfig = req.routeOptions?.config;
    if (routeConfig?.public === true) return;
    if (!authEnabled()) return;

    const presented = extractBearer(req.headers.authorization);
    if (presented === undefined) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }
    const tokenPayload = verifyToken(presented);
    if (tokenPayload !== undefined) {
      // Initial-login tokens (issued because the user authenticated
      // with the env-supplied UI_PASSWORD and REQUIRE_PASSWORD_CHANGE
      // is on) are scoped to the change-password endpoint only. Every
      // other API call returns 403 with a stable code the client uses
      // to render the change-password screen.
      if (tokenPayload.mustChangePassword) {
        reply.code(403).send({
          error: "must_change_password",
          message:
            "this token is scoped to POST /auth/change-password — change " +
            "the initial password before calling other endpoints",
        });
        return;
      }
      return;
    }
    if (verifyApiKey(presented)) return;
    reply.code(401).send({ error: "invalid_token" });
  });

  await fastify.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(projectRoutes);
      await api.register(sessionRoutes);
      await api.register(streamRoutes);
      await api.register(promptRoutes);
      await api.register(controlRoutes);
      await api.register(configRoutes);
      await api.register(fileRoutes);
      await api.register(gitRoutes);
      await api.register(execRoutes);
      await api.register(exportRoutes);
      await api.register(mcpRoutes);
      await api.register(quickActionRoutes);
      await api.register(askUserQuestionRoutes);
      await api.register(todoRoutes);
      await api.register(processesRoutes);
      await api.register(webhookRoutes);
      await api.register(orchestrationRoutes);
      await api.register(searchRoutes);
      await api.register(terminalRoutes);
    },
    { prefix: "/api/v1" },
  );

  // ---- static client (production) ----
  // In Docker / `npm run build && node dist/index.js`, Fastify serves the
  // Vite build directly so the whole app runs on a single port. In dev,
  // Vite owns :5173 and proxies to us, so we skip this when the dist
  // directory doesn't exist (or `SERVE_CLIENT=false`).
  //
  // SPA fallback: any non-/api/* GET that didn't match a static asset
  // returns `index.html` so the React Router-less hash-free URLs (e.g.
  // bookmarked deep links) hydrate the SPA instead of 404ing.
  if (config.serveClient && existsSync(config.clientDistPath)) {
    // onSend hook tags the right Cache-Control by request path. Doing it
    // here (rather than @fastify/static's `setHeaders`) is reliable because
    // it runs after the static plugin sets its default `max-age=0`, so we
    // overwrite cleanly. /assets/ paths are content-addressed by Vite, so
    // they're year-long immutable; index.html (which is what / and any
    // SPA-fallback path returns) must always revalidate so a fresh deploy
    // lands on the next reload.
    fastify.addHook("onSend", async (req, reply) => {
      const path = req.url.split("?")[0] ?? req.url;
      // API responses already control their own caching headers (or
      // intentionally don't); skip the static-asset branching for them.
      if (path.startsWith("/api/")) return;
      if (path.startsWith("/assets/")) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (reply.getHeader("content-type")?.toString().startsWith("text/html") === true) {
        reply.header("Cache-Control", "no-cache");
      }
    });

    await fastify.register(fastifyStatic, {
      root: config.clientDistPath,
      index: "index.html",
    });

    fastify.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? req.url;
      // The API surface explicitly 404s — never fall through to the SPA.
      if (path.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      // SPA fallback: bare GETs without a file extension are deep links
      // (/projects/abc, /sessions/xyz). Anything with an extension that
      // got here is a missing static asset and should 404 honestly so
      // the browser surfaces it instead of silently rendering the shell.
      const lastSegment = path.split("/").pop() ?? "";
      const looksLikeAsset = lastSegment.includes(".");
      if (req.method !== "GET" || looksLikeAsset) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).type("text/html").sendFile("index.html");
    });

    fastify.log.info({ root: config.clientDistPath }, "serving client from disk");
  } else {
    fastify.log.info(
      { dist: config.clientDistPath, exists: existsSync(config.clientDistPath) },
      "client dist not served (dev mode or SERVE_CLIENT=false)",
    );
  }

  // Clean teardown on fastify.close() (called by both graceful shutdown and
  // tests via `await fastify.close()`). Disposes every live session, which
  // will also become load-bearing in Phase 5 to flush SSE clients.
  fastify.addHook("onClose", async () => {
    await disposeAllSessions();
    disposeAllPtys();
    await disposeAllMcp();
  });

  // Boot-time MCP load. Eagerly connects every enabled GLOBAL server
  // so /mcp/settings reports honest connection counts before the
  // first session is created. Project-scope servers load lazily on
  // first session-create per project. Failure here is non-fatal —
  // a bad mcp.json shouldn't keep pi-forge from booting.
  loadGlobalMcp().catch((err: unknown) => {
    fastify.log.error({ err }, "mcp: initial load failed");
  });

  // Wire the ask-user-question registry into SSE so per-session
  // events ("agent invoked the tool" / "request was answered or
  // cancelled") fan out to every live browser client of that
  // session. One subscription for the lifetime of the process.
  initAskUserQuestionFanout();
  initTodoFanout();
  initProcessesFanout();
  startExternalSubagentsWatcher();

  // Webhook bridges for the same forge-native event channels. Each
  // subscribes alongside the SSE fanout so webhooks see the same
  // events SSE clients see, without coupling the two systems.
  // Per-AgentSession events (agent_end, etc.) are wired directly
  // inside session-registry's subscribe handler — those need the
  // LiveSession context at construction time, not from a singleton
  // channel.
  initAskUserQuestionWebhookBridge();
  initProcessesWebhookBridge();

  // Orchestration bridges for the same forge-native event channels.
  // Per-AgentSession events (agent_end, auto_retry_end) are wired
  // directly inside session-registry's subscribe handler — those
  // need the LiveSession context at construction time. These two
  // singleton-channel sources are subscribed once at boot.
  initOrchestrationAskUserQuestionBridge();
  initOrchestrationProcessesBridge();

  return fastify;
}

export async function start(): Promise<void> {
  // Ensure the workspace + forge data dirs exist before anything
  // tries to write under them. mkdir(recursive:true) is a no-op on an
  // existing dir, so this is safe to run on every boot. We do NOT
  // create PI_CONFIG_DIR — that's the SDK's territory and the SDK
  // creates it itself on first auth/models read.
  for (const dir of [config.workspacePath, config.forgeDataDir]) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      // EACCES on `/workspace` (the legacy default) was the most common
      // dev startup failure. Surface a clear hint instead of letting
      // Fastify start in a broken state.
      console.error(`[pi-forge] failed to create directory ${dir}:`, (err as Error).message);
      console.error(`[pi-forge] hint: set WORKSPACE_PATH/FORGE_DATA_DIR to a writable location`);
      process.exit(1);
    }
  }
  try {
    await applySandboxStartupChowns();
  } catch (err) {
    console.error("[pi-forge] failed to apply sandbox startup chowns:", (err as Error).message);
    process.exit(1);
  }

  const fastify = await buildServer();
  // One-line confirmation of optional security knobs that are easy to
  // typo or forget to wire through. If you add another opt-in
  // behavioral toggle here, log its state too — operators should be
  // able to grep container logs for the answer to "did my env var
  // take effect" without sending a test prompt.
  logSecretHygieneState();
  try {
    await fastify.listen({ port: config.port, host: config.host });
    fastify.log.info(`pi-forge server listening on :${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void start();
}
