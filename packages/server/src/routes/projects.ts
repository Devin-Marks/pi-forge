import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { join, resolve } from "node:path";
import { config } from "../config.js";
import {
  assertTargetClonable,
  cloneRepository,
  GitCloneError,
  validateCloneUrl,
  type CloneEvent,
} from "../git-clone.js";
import {
  browseDirectory,
  createDirectory,
  createProject,
  deleteProject,
  DuplicatePathError,
  getProject,
  InvalidDirectoryNameError,
  InvalidNameError,
  NotADirectoryError,
  PathOutsideWorkspaceError,
  ProjectNotFoundError,
  readProjects,
  renameProject,
} from "../project-manager.js";
import {
  getProjectSystemPromptAddendum,
  MAX_ADDENDUM_BYTES,
  setProjectSystemPromptAddendum,
} from "../system-prompt-overrides.js";
import { errorSchema } from "./_schemas.js";

/**
 * Heartbeat cadence for the clone SSE stream. Same value as
 * `sse-bridge.ts:HEARTBEAT_INTERVAL_MS` — keeps comfortable margin
 * under the OpenShift HAProxy `timeout server` default of 30s.
 */
const CLONE_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * One-shot padding flush after the `started` event so OpenShift's
 * HAProxy router releases the small initial frames immediately
 * instead of holding them through the multi-second clone. Same
 * pattern as `sse-bridge.ts:COMPACTION_START_PADDING_LINE` — see
 * that doc-comment for the rationale.
 */
const CLONE_PADDING_BYTES = 2048;
const CLONE_PADDING_LINE = `: pad-flush ${"_".repeat(CLONE_PADDING_BYTES - 14)}\n\n`;

const projectSchema = {
  type: "object",
  required: ["id", "name", "path", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PathOutsideWorkspaceError) {
    return reply.code(403).send({ error: "path_not_allowed" });
  }
  if (err instanceof NotADirectoryError) {
    return reply.code(400).send({ error: "not_a_directory" });
  }
  if (err instanceof ProjectNotFoundError) {
    return reply.code(404).send({ error: "project_not_found" });
  }
  if (err instanceof InvalidNameError) {
    return reply.code(400).send({ error: "invalid_name" });
  }
  if (err instanceof InvalidDirectoryNameError) {
    return reply.code(400).send({ error: "invalid_directory_name" });
  }
  if (err instanceof DuplicatePathError) {
    return reply.code(409).send({ error: "duplicate_path" });
  }
  if ((err as NodeJS.ErrnoException).code === "EEXIST") {
    return reply.code(409).send({ error: "already_exists" });
  }
  reply.log.error({ err }, "projects route error");
  return reply.code(500).send({ error: "internal_error" });
}

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/projects",
    {
      schema: {
        description: "List all projects.",
        tags: ["projects"],
        response: {
          200: {
            type: "object",
            required: ["projects"],
            properties: {
              projects: { type: "array", items: projectSchema },
            },
          },
        },
      },
    },
    async () => ({ projects: await readProjects() }),
  );

  fastify.post<{ Body: { name: string; path: string } }>(
    "/projects",
    {
      schema: {
        description:
          "Create a project pointing at an existing folder inside WORKSPACE_PATH. " +
          "Returns 403 for paths outside the workspace, 400 if the path is not a " +
          "directory, 409 if another project already points at the same path.",
        tags: ["projects"],
        body: {
          type: "object",
          required: ["name", "path"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            path: { type: "string", minLength: 1 },
          },
        },
        response: {
          201: projectSchema,
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await createProject(req.body.name, req.body.path);
        return reply.code(201).send(project);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/projects/:id",
    {
      schema: {
        description: "Rename a project. Does not move or rename the underlying directory.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
        },
        response: {
          200: projectSchema,
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        return await renameProject(req.params.id, req.body.name);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/projects/:id",
    {
      schema: {
        description:
          "Delete the project record AND rm -rf the project's session " +
          "directory (`${SESSION_DIR}/<id>/`) including every session " +
          "JSONL inside. The project's workspace folder " +
          "(`${WORKSPACE_PATH}/<projectName>/`) is left alone — that's " +
          "almost always real work the user wants to keep.\n\n" +
          "Earlier versions accepted a `?cascade=0|1` query param to opt " +
          "into the session-dir cleanup. v1.3.0 dropped the param and " +
          "made cleanup unconditional — the default-off behavior left a " +
          "`<projectId>/` directory on disk that the UI had no way to " +
          "reach. User-facing confirmation about deleting N session " +
          "files happens at the UI layer (a required checkbox in the " +
          "delete dialog when sessions are present); programmatic " +
          "clients get the same atomic delete with no opt.\n\n" +
          "Session-dir cleanup is best-effort: a missing dir is not an " +
          "error, and an rm failure does NOT fail the delete (the project " +
          "record is already gone at that point).",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["cascaded"],
            properties: { cascaded: { type: "boolean" } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await deleteProject(req.params.id, {
          logWarn: (obj, msg) => req.log.warn(obj, msg),
        });
        return reply.code(200).send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/projects/:id",
    {
      schema: {
        description: "Get a single project by id.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: projectSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found" });
      return project;
    },
  );

  fastify.get<{ Querystring: { path?: string } }>(
    "/projects/browse",
    {
      schema: {
        description:
          "List subdirectories of `path` (defaults to WORKSPACE_PATH). " +
          "Each entry includes whether it contains a .git directory. " +
          "Rejects paths outside WORKSPACE_PATH with 403.",
        tags: ["projects"],
        querystring: {
          type: "object",
          properties: { path: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["path", "parentPath", "entries"],
            properties: {
              path: { type: "string" },
              parentPath: { type: ["string", "null"] },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "path", "isGitRepo"],
                  properties: {
                    name: { type: "string" },
                    path: { type: "string" },
                    isGitRepo: { type: "boolean" },
                  },
                },
              },
            },
          },
          400: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await browseDirectory(req.query.path);
        return {
          path: result.path,
          parentPath: result.parentPath ?? null,
          entries: result.entries,
        };
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/projects/:id/system-prompt",
    {
      schema: {
        description:
          "Return the project's system-prompt addendum — free-form text " +
          "appended to the agent's base system prompt for every session in " +
          "this project. Empty string when no addendum is set. The base " +
          "prompt (pi's tool-calling protocol) is NOT exposed or editable; " +
          "this is APPEND-only.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["addendum", "maxBytes"],
            properties: {
              addendum: { type: "string" },
              maxBytes: { type: "integer" },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found" });
      const addendum = await getProjectSystemPromptAddendum(req.params.id);
      return { addendum, maxBytes: MAX_ADDENDUM_BYTES };
    },
  );

  fastify.put<{ Params: { id: string }; Body: { addendum: string } }>(
    "/projects/:id/system-prompt",
    {
      schema: {
        description:
          "Replace the project's system-prompt addendum. Pass an empty " +
          "string (or whitespace-only) to clear the addendum. Takes effect " +
          "on the NEXT session created in this project — already-running " +
          "sessions keep the prompt they were built with.",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["addendum"],
          additionalProperties: false,
          properties: {
            addendum: { type: "string", maxLength: MAX_ADDENDUM_BYTES },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["addendum", "maxBytes"],
            properties: {
              addendum: { type: "string" },
              maxBytes: { type: "integer" },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found" });
      // Belt-and-suspenders: schema enforces maxLength at the character
      // level, but multi-byte input could in principle exceed the byte
      // cap. Reject explicitly so the persisted file is bounded.
      if (Buffer.byteLength(req.body.addendum, "utf8") > MAX_ADDENDUM_BYTES) {
        return reply.code(400).send({ error: "addendum_too_large" });
      }
      await setProjectSystemPromptAddendum(req.params.id, req.body.addendum);
      const addendum = await getProjectSystemPromptAddendum(req.params.id);
      return { addendum, maxBytes: MAX_ADDENDUM_BYTES };
    },
  );

  fastify.post<{
    Body: {
      url: string;
      parentPath: string;
      folderName: string;
      projectName: string;
      branch?: string;
      token?: string;
    };
  }>(
    "/projects/clone",
    {
      schema: {
        description:
          "Clone a git repository into a new folder under WORKSPACE_PATH, then " +
          "create a project pointing at it. Streams progress as SSE events.\n\n" +
          "Event types on the stream:\n" +
          "  - `started`  — {cloneUrlForDisplay} (URL with credentials stripped)\n" +
          "  - `progress` — {phase, percent, raw} (one per `git clone --progress` line)\n" +
          "  - `stderr`   — {line} (other stderr text — non-progress, non-fatal)\n" +
          "  - `done`     — {project} (the created Project record)\n" +
          "  - `error`    — {message, code} (fatal — connection then closes)\n\n" +
          "Auth: optional `token` is embedded as `x-access-token:<token>` in the " +
          "clone URL (GitHub convention; works for most providers). The token is " +
          "stripped from the stored `origin` URL after a successful clone so it " +
          "doesn't persist in `.git/config`. On failure the target dir is " +
          "rm -rf'd so no token bytes survive.",
        tags: ["projects"],
        body: {
          type: "object",
          required: ["url", "parentPath", "folderName", "projectName"],
          additionalProperties: false,
          properties: {
            url: { type: "string", minLength: 1 },
            parentPath: { type: "string", minLength: 1 },
            folderName: { type: "string", minLength: 1, maxLength: 100 },
            projectName: { type: "string", minLength: 1, maxLength: 200 },
            branch: { type: "string", maxLength: 250 },
            token: { type: "string", maxLength: 4096 },
          },
        },
        response: {
          // SSE responses don't fit Fastify's response-schema model;
          // only the pre-stream error shapes are declared. The
          // catalog of event types is in the description above.
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { url, parentPath, folderName, projectName, branch, token } = req.body;

      // ---- pre-stream validation: errors land as plain JSON 4xx ----
      try {
        validateCloneUrl(url);
      } catch (err) {
        if (err instanceof GitCloneError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      // Folder-name validation mirrors createDirectory's rules.
      if (
        folderName.includes("/") ||
        folderName.includes("\\") ||
        folderName === "." ||
        folderName === ".."
      ) {
        return reply.code(400).send({ error: "invalid_directory_name" });
      }
      // Resolve target path and confirm it's inside WORKSPACE_PATH.
      // Reuses the project-manager error so the route surface stays
      // consistent.
      const parentResolved = resolve(parentPath);
      const targetPath = join(parentResolved, folderName);
      const workspaceResolved = resolve(config.workspacePath);
      if (
        !parentResolved.startsWith(workspaceResolved + "/") &&
        parentResolved !== workspaceResolved
      ) {
        return reply.code(403).send({ error: "path_not_allowed" });
      }
      if (!targetPath.startsWith(workspaceResolved + "/") && targetPath !== workspaceResolved) {
        return reply.code(403).send({ error: "path_not_allowed" });
      }
      try {
        await assertTargetClonable(targetPath);
      } catch (err) {
        if (err instanceof GitCloneError) {
          const status = err.code === "target_not_empty" ? 409 : 400;
          return reply.code(status).send({ error: err.code, message: err.message });
        }
        throw err;
      }

      // ---- start streaming ----
      reply.hijack();
      const raw = reply.raw;
      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        try {
          raw.end();
        } catch {
          /* socket already torn down */
        }
      };
      const writeRaw = (chunk: string): void => {
        if (closed) return;
        try {
          raw.write(chunk);
        } catch {
          close();
        }
      };
      const writeEvent = (event: CloneEvent): void => {
        writeRaw(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      } catch (err) {
        req.log.error({ err }, "clone prelude failed");
        try {
          raw.destroy();
        } catch {
          /* already destroyed */
        }
        return;
      }
      heartbeat = setInterval(() => writeRaw(": heartbeat\n\n"), CLONE_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      // Abort the clone if the client disconnects mid-stream.
      const ac = new AbortController();
      raw.on("close", () => {
        ac.abort();
        close();
      });
      raw.on("error", () => {
        ac.abort();
        close();
      });

      const cloneOpts: import("../git-clone.js").CloneOptions = {
        url,
        target: targetPath,
        signal: ac.signal,
      };
      if (branch !== undefined && branch.length > 0) cloneOpts.branch = branch;
      if (token !== undefined && token.length > 0) cloneOpts.token = token;
      const { promise, events } = cloneRepository(cloneOpts);

      // Stream every event to the client. After the `started` event,
      // send a one-shot padding flush so HAProxy releases the small
      // frames immediately rather than holding them through the
      // multi-second clone (same pattern as the compaction-start
      // padding flush in sse-bridge.ts).
      let sentPadding = false;
      let cloneSucceeded = false;
      for await (const e of events) {
        writeEvent(e);
        if (!sentPadding && e.type === "started") {
          writeRaw(CLONE_PADDING_LINE);
          sentPadding = true;
        }
        if (e.type === "done") cloneSucceeded = true;
        if (closed) break;
      }
      await promise;

      // Create the project record on success, then emit a final
      // event with the project shape so the client can navigate
      // straight to it. The `done` event from the clone module
      // already fired above with `target`; this is a separate
      // `project_created` event so the contract is unambiguous.
      if (cloneSucceeded && !closed) {
        try {
          const project = await createProject(projectName, targetPath);
          writeRaw(`data: ${JSON.stringify({ type: "project_created", project })}\n\n`);
        } catch (err) {
          const code =
            err instanceof DuplicatePathError
              ? "duplicate_path"
              : err instanceof PathOutsideWorkspaceError
                ? "path_not_allowed"
                : err instanceof InvalidNameError
                  ? "invalid_name"
                  : "project_create_failed";
          const message = err instanceof Error ? err.message : String(err);
          writeRaw(`data: ${JSON.stringify({ type: "error", code, message })}\n\n`);
        }
      }
      close();
    },
  );

  fastify.post<{ Body: { parentPath: string; name: string } }>(
    "/projects/browse/mkdir",
    {
      schema: {
        description:
          "Create a directory inside WORKSPACE_PATH. Used by the folder picker's " +
          "'New folder' button. Rejects paths outside WORKSPACE_PATH with 403.",
        tags: ["projects"],
        body: {
          type: "object",
          required: ["parentPath", "name"],
          additionalProperties: false,
          properties: {
            parentPath: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" } },
          },
          400: errorSchema,
          403: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const path = await createDirectory(req.body.parentPath, req.body.name);
        return reply.code(201).send({ path });
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );
};
