import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";
import { sessionCount } from "../session-registry.js";
import { ptyCount } from "../pty-manager.js";
import { config, passwordAuthEnabled } from "../config.js";
import { isOrchestrationEnabled } from "../orchestration/config.js";

/**
 * Read the server's own package.json once at module load. Used by the
 * /ui-config response so the browser can render an "About" footer
 * with the deployed version.
 *
 * The published artifact layouts to handle:
 *   - In-repo dev (tsx watch from src/): code lives at
 *     `packages/server/src/routes/health.ts`. Up-two = `packages/server/`.
 *   - In-repo built (dist/): code lives at
 *     `packages/server/dist/routes/health.js`. Up-two = `packages/server/`.
 *   - Docker image (built): code lives at
 *     `/app/packages/server/dist/routes/health.js`. Up-two =
 *     `/app/packages/server/`.
 *   - npm publish (flat): the synthetic publish dir flattens both
 *     workspaces under `dist/`, so code lives at
 *     `<install>/dist/server/routes/health.js`. Up-two would be
 *     `<install>/dist/` — which has NO package.json. Up-three is
 *     `<install>/` which has the synthetic `package.json` carrying
 *     the right version.
 *
 * v1.1.4 shipped with only the up-two probe and surfaced "0.0.0" in
 * the About panel for npm-installed users. We now try up-two first
 * (preserves the workspace package.json's authority for in-repo and
 * Docker), then up-three (catches the published flat layout). First
 * resolvable hit wins; if neither hits, fall back to "0.0.0".
 */
const SERVER_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "package.json"), // workspace / Docker
    join(here, "..", "..", "..", "package.json"), // npm publish (flat layout)
  ];
  for (const pkgPath of candidates) {
    try {
      const raw = readFileSync(pkgPath, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return "0.0.0";
})();

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/health",
    {
      config: { public: true },
      schema: {
        description: "Health check — no auth required.",
        tags: ["health"],
        security: [],
        response: {
          200: {
            type: "object",
            required: ["status", "activeSessions", "activePtys"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              activeSessions: { type: "integer", minimum: 0 },
              activePtys: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok" as const,
      activeSessions: sessionCount(),
      activePtys: ptyCount(),
    }),
  );

  // Public, no-auth UI config — the browser fetches this at boot to
  // know which surfaces to render. Kept on the health-route plugin
  // because both share the "no-auth, fetched once at boot" profile.
  fastify.get(
    "/ui-config",
    {
      config: { public: true },
      schema: {
        description:
          "Frontend feature flags + a few server-derived constants the " +
          "client needs at boot. No auth — runs before the auth check so " +
          "the login screen can read the same flags.",
        tags: ["health"],
        security: [],
        response: {
          200: {
            type: "object",
            required: [
              "minimal",
              "workspaceRoot",
              "version",
              "passwordAuthEnabled",
              "orchestrationEnabled",
            ],
            properties: {
              // True when MINIMAL_UI is set: hides terminal, git pane,
              // last-turn pane, and providers/agent settings sections;
              // replaces the folder picker with a name-only project
              // create form rooted at `workspaceRoot`.
              minimal: { type: "boolean" },
              // Absolute path of the workspace root. Minimal-mode
              // project creation builds `<workspaceRoot>/<name>`.
              workspaceRoot: { type: "string" },
              // Server build version (mirrors packages/server's
              // package.json). Surfaced in the General settings tab
              // so users can confirm which release they're hitting
              // without shelling into the container.
              version: { type: "string" },
              // True when the deployment supports the browser
              // password-change flow (env UI_PASSWORD set OR a
              // persisted password-hash exists). API-key-only
              // deployments report false; the Settings → General
              // password change section hides in that case.
              passwordAuthEnabled: { type: "boolean" },
              // True iff session orchestration is reachable. Off
              // when ORCHESTRATION_ENABLED is unset OR MINIMAL_UI
              // is true (orchestration is hard-disabled under
              // MINIMAL_UI regardless of the env flag).
              orchestrationEnabled: { type: "boolean" },
            },
          },
        },
      },
    },
    async () => ({
      minimal: config.minimalUi,
      workspaceRoot: config.workspacePath,
      version: SERVER_VERSION,
      passwordAuthEnabled: passwordAuthEnabled(),
      orchestrationEnabled: isOrchestrationEnabled(),
    }),
  );
};
