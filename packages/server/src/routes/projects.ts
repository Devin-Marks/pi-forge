import type { FastifyPluginAsync, FastifyReply } from "fastify";
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

  fastify.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/projects/:id",
    {
      schema: {
        description:
          "Delete the project record. With `?cascade=1` ALSO removes the " +
          "project's on-disk session directory (under `${SESSION_DIR}/<id>/`); " +
          "without it, those files are left in place and become orphaned. " +
          "Cascade cleanup is best-effort — a missing dir is not an error, " +
          "and an rm failure does NOT fail the delete (the project record " +
          "is already gone at that point).",
        tags: ["projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            cascade: { type: "string", enum: ["0", "1", "true", "false"] },
          },
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
        const cascade = req.query.cascade === "1" || req.query.cascade === "true";
        const result = await deleteProject(req.params.id, {
          cascadeSessionDir: cascade,
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
