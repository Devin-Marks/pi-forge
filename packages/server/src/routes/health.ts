import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";
import { sessionCount } from "../session-registry.js";
import { ptyCount } from "../pty-manager.js";
import { config } from "../config.js";

/**
 * Read the server's own package.json once at module load. Used by the
 * /ui-config response so the browser can render an "About" footer
 * with the deployed version. Resolves relative to the compiled
 * server file (`packages/server/dist/routes/health.js`) — three
 * `../` to reach the package root regardless of whether this runs
 * from `dist/` (production) or `src/` (tsx watch dev mode).
 */
const SERVER_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
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
            required: ["minimal", "workspaceRoot", "version"],
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
              // package.json). Surfaced in the About tab so users can
              // confirm which release they're hitting without shelling
              // into the container.
              version: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      minimal: config.minimalUi,
      workspaceRoot: config.workspacePath,
      version: SERVER_VERSION,
    }),
  );
};
