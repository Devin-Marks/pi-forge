import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  deleteMcpServer,
  readMcpJsonRedacted,
  setMcpDisabled,
  setMcpTruncationConfig,
  upsertMcpServer,
  type McpServerConfig,
  type McpTransport,
} from "../mcp/config.js";
import {
  customToolsForProject,
  ensureProjectLoaded,
  getStatus,
  isGloballyEnabled,
  probe,
  reconnectGatedStdioForProject,
  reloadGlobal,
  unloadProject,
} from "../mcp/manager.js";
import { grantStdioTrust, isStdioTrustedForProject, revokeStdioTrust } from "../mcp/stdio-trust.js";
import { getMcpResultTruncationSettings } from "../mcp/tool-bridge.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

interface McpServerBody {
  enabled?: boolean;
  // remote
  url?: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

const serverConfigSchema = {
  // Required-fields validation is presence-based (one of url / command),
  // enforced in `buildServerConfigFromBody` below. JSON Schema's
  // `oneOf` works but the ajv error messages it emits are useless for
  // the user; the explicit handler check stays the source of truth.
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    url: { type: "string", minLength: 1 },
    transport: { type: "string", enum: ["auto", "streamable-http", "sse"] },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    cwd: { type: "string", minLength: 1 },
  },
} as const;

const statusEntrySchema = {
  type: "object",
  required: ["scope", "name", "kind", "enabled", "state", "toolCount"],
  properties: {
    scope: { type: "string", enum: ["global", "project"] },
    projectId: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", enum: ["remote", "stdio"] },
    url: { type: "string" },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    enabled: { type: "boolean" },
    state: {
      type: "string",
      enum: ["idle", "connecting", "connected", "error", "disabled", "trust_required"],
    },
    toolCount: { type: "integer", minimum: 0 },
    lastError: { type: "string" },
    transport: { type: "string", enum: ["auto", "streamable-http", "sse"] },
  },
} as const;

/**
 * Validate the presence-based one-of constraint and copy the body
 * into a fresh `McpServerConfig`. Either branch ↦ returns the
 * config; ambiguous / empty input ↦ writes the 400 to `reply` and
 * returns undefined (caller short-circuits with the same reply).
 */
function buildServerConfigFromBody(
  body: McpServerBody,
  reply: FastifyReply,
): McpServerConfig | undefined {
  const hasUrl = typeof body.url === "string" && body.url.length > 0;
  const hasCommand = typeof body.command === "string" && body.command.length > 0;
  if (hasUrl && hasCommand) {
    reply.code(400).send({
      error: "mcp_invalid_config",
      message: "an MCP server must declare either `url` (remote) or `command` (stdio), not both",
    });
    return undefined;
  }
  if (!hasUrl && !hasCommand) {
    reply.code(400).send({
      error: "mcp_invalid_config",
      message: "an MCP server must declare either `url` (remote) or `command` (stdio)",
    });
    return undefined;
  }
  const cfg: McpServerConfig = {};
  if (body.enabled !== undefined) cfg.enabled = body.enabled;
  // Re-derive the narrowed strings instead of using `body.url!` —
  // exactOptionalPropertyTypes refuses to widen the assignment
  // target to `string | undefined` even when `hasUrl` proved
  // non-undefined a few lines up.
  if (hasUrl && body.url !== undefined) {
    cfg.url = body.url;
    if (body.transport !== undefined) cfg.transport = body.transport;
    if (body.headers !== undefined) cfg.headers = body.headers;
  } else if (body.command !== undefined) {
    cfg.command = body.command;
    if (body.args !== undefined) cfg.args = [...body.args];
    if (body.env !== undefined) cfg.env = body.env;
    if (body.cwd !== undefined) cfg.cwd = body.cwd;
  }
  return cfg;
}

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- master enable/disable + connection summary ----
  fastify.get(
    "/mcp/settings",
    {
      schema: {
        description:
          "Master MCP toggle + a compact connection summary the header " +
          "badge consumes. `enabled` mirrors `mcp.json#disabled === false`. " +
          "`connected` / `total` count GLOBAL servers only (project-scope " +
          "counts come from /mcp/servers?projectId=...). `truncation` controls " +
          "the MCP text-result cap applied before results enter agent context.",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["enabled", "connected", "total", "truncation"],
            properties: {
              enabled: { type: "boolean" },
              connected: { type: "integer", minimum: 0 },
              total: { type: "integer", minimum: 0 },
              truncation: {
                type: "object",
                required: ["enabled", "maxChars"],
                properties: {
                  enabled: { type: "boolean" },
                  maxChars: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const status = getStatus();
      const enabled = isGloballyEnabled();
      const total = status.length;
      const connected = status.filter((s) => s.state === "connected").length;
      return { enabled, connected, total, truncation: getMcpResultTruncationSettings() };
    },
  );

  fastify.put<{
    Body: { enabled?: boolean; truncation?: { enabled?: boolean; maxChars?: number } };
  }>(
    "/mcp/settings",
    {
      schema: {
        description:
          "Update MCP settings. The master enabled flag controls whether MCP tools are passed " +
          "into createAgentSession (existing live sessions are unaffected). The truncation " +
          "setting controls whether MCP text results are capped before they enter agent context.",
        tags: ["config"],
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            truncation: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                maxChars: { type: "integer", minimum: 1, maximum: 1000000 },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["enabled", "connected", "total", "truncation"],
            properties: {
              enabled: { type: "boolean" },
              connected: { type: "integer", minimum: 0 },
              total: { type: "integer", minimum: 0 },
              truncation: {
                type: "object",
                required: ["enabled", "maxChars"],
                properties: {
                  enabled: { type: "boolean" },
                  maxChars: { type: "integer", minimum: 1 },
                },
              },
            },
          },
          400: errorSchema,
        },
      },
    },
    async (req) => {
      if (req.body.enabled !== undefined) {
        await setMcpDisabled(!req.body.enabled);
      }
      if (req.body.truncation !== undefined) {
        await setMcpTruncationConfig(req.body.truncation);
      }
      await reloadGlobal();
      const status = getStatus();
      return {
        enabled: isGloballyEnabled(),
        total: status.length,
        connected: status.filter((s) => s.state === "connected").length,
        truncation: getMcpResultTruncationSettings(),
      };
    },
  );

  // ---- list global servers (config view; redacted) ----
  fastify.get(
    "/mcp/servers",
    {
      schema: {
        description:
          "List the GLOBAL MCP server registry (pi-forge-owned at " +
          "${FORGE_DATA_DIR}/mcp.json). Header / env values are redacted " +
          "with the same '***REDACTED***' sentinel pattern as models.json. " +
          "Pass ?projectId=<id> to also include the project-scoped " +
          "registry (read from <projectPath>/.mcp.json). When " +
          "?projectId is set, `stdioTrust` reports whether the operator " +
          "has granted the project permission to declare stdio MCP " +
          "servers (project-scoped stdio entries that haven't been " +
          "trusted appear in status with state='trust_required').",
        tags: ["config"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["servers", "status"],
            properties: {
              servers: { type: "object", additionalProperties: serverConfigSchema },
              status: { type: "array", items: statusEntrySchema },
              stdioTrust: {
                type: "object",
                required: ["trusted"],
                properties: { trusted: { type: "boolean" } },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (req) => {
      const projectId = (req.query as { projectId?: string }).projectId;
      // If a project was passed, eagerly load its .mcp.json so the
      // status array reflects current state. The global file is
      // already loaded at server boot.
      let stdioTrust: { trusted: boolean } | undefined;
      if (projectId !== undefined) {
        const project = await getProject(projectId);
        if (project !== undefined) {
          await ensureProjectLoaded(project.id, project.path);
          stdioTrust = { trusted: await isStdioTrustedForProject(project.id) };
        }
      }
      const cfg = await readMcpJsonRedacted();
      const result: {
        servers: Record<string, McpServerConfig>;
        status: ReturnType<typeof getStatus>;
        stdioTrust?: { trusted: boolean };
      } = {
        servers: cfg.servers,
        status: getStatus(projectId !== undefined ? { projectId } : undefined),
      };
      if (stdioTrust !== undefined) result.stdioTrust = stdioTrust;
      return result;
    },
  );

  // ---- create / replace a global server ----
  fastify.put<{ Params: { name: string }; Body: McpServerBody }>(
    "/mcp/servers/:name",
    {
      schema: {
        description:
          "Create or replace a GLOBAL MCP server entry. Project-scoped " +
          "servers are read-only via this API — edit `.mcp.json` at the " +
          "project root. Headers carrying the '***REDACTED***' sentinel " +
          "are merged with the prior on-disk value (same pattern as " +
          "PUT /config/models).",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        },
        body: serverConfigSchema,
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const cfg = buildServerConfigFromBody(req.body, reply);
      if (cfg === undefined) return reply;
      await upsertMcpServer(name, cfg);
      await reloadGlobal();
      return { ok: true };
    },
  );

  // ---- delete a global server ----
  fastify.delete<{ Params: { name: string } }>(
    "/mcp/servers/:name",
    {
      schema: {
        description:
          "Remove a GLOBAL MCP server entry. Project-scoped servers must " +
          "be removed by editing the project's `.mcp.json` file directly.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["removed"],
            properties: { removed: { type: "boolean" } },
          },
          500: errorSchema,
        },
      },
    },
    async (req) => {
      const removed = await deleteMcpServer(req.params.name);
      if (removed) await reloadGlobal();
      return { removed };
    },
  );

  // ---- probe (force reconnect + relist tools) ----
  fastify.post<{ Params: { name: string }; Querystring: { projectId?: string } }>(
    "/mcp/servers/:name/probe",
    {
      schema: {
        description:
          "Force a reconnect for the named server and return the new " +
          "status entry. Pass ?projectId=<id> to probe a project-scoped " +
          "server (defaults to the global server with that name).",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: statusEntrySchema },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const projectId = req.query.projectId;
      if (projectId !== undefined) {
        const project = await getProject(projectId);
        if (project === undefined) {
          return reply.code(404).send({ error: "project_not_found" });
        }
        await ensureProjectLoaded(project.id, project.path);
        const status = await probe({ project: project.id }, name);
        if (status === undefined) {
          return reply.code(404).send({ error: "mcp_server_not_found" });
        }
        return { status };
      }
      const status = await probe("global", name);
      if (status === undefined) {
        return reply.code(404).send({ error: "mcp_server_not_found" });
      }
      return { status };
    },
  );

  // ---- list aggregated tools for a project ----
  fastify.get<{ Querystring: { projectId: string } }>(
    "/mcp/tools",
    {
      schema: {
        description:
          "Flat list of every MCP tool currently available to sessions in " +
          "the given project (global ∪ project, project wins on name " +
          "collision). Use this for diagnostic/status displays — the actual " +
          "wiring into createAgentSession happens server-side.",
        tags: ["config"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["tools"],
            properties: {
              tools: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "description"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      await ensureProjectLoaded(project.id, project.path);
      const tools = customToolsForProject(project.id).map((t) => ({
        name: t.name,
        description: t.description,
      }));
      return { tools };
    },
  );

  // ---- stdio trust: grant + revoke per-project ----
  fastify.post<{ Params: { projectId: string } }>(
    "/mcp/trust/:projectId",
    {
      schema: {
        description:
          "Grant this project permission to declare stdio (subprocess- " +
          "spawning) MCP servers in its `.mcp.json`. Required before " +
          "pi-forge will spawn any stdio entry from a project's config " +
          "file — otherwise the entries appear in status with " +
          "state='trust_required' and produce no tools. Granting trust " +
          "immediately retries connection for every gated stdio entry " +
          "in the project; remote entries are unaffected. Globally- " +
          "configured stdio entries (in ${FORGE_DATA_DIR}/mcp.json) are " +
          "never gated — they're the operator's own config.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["trusted", "status"],
            properties: {
              trusted: { type: "boolean" },
              status: { type: "array", items: statusEntrySchema },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.params.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      await grantStdioTrust(project.id);
      await ensureProjectLoaded(project.id, project.path);
      await reconnectGatedStdioForProject(project.id);
      return {
        trusted: true,
        status: getStatus({ projectId: project.id }),
      };
    },
  );

  fastify.delete<{ Params: { projectId: string } }>(
    "/mcp/trust/:projectId",
    {
      schema: {
        description:
          "Revoke this project's stdio MCP trust. Disconnects every " +
          "running project-scoped MCP server (including remote ones — " +
          "the whole project pool is reset so the next ensureProjectLoaded " +
          "re-applies the trust gate to stdio entries). The trust grant " +
          "is also cleared automatically when the project itself is " +
          "deleted (project-manager.deleteProject cascade).",
        tags: ["config"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["trusted"],
            properties: { trusted: { type: "boolean" } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.params.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      await revokeStdioTrust(project.id);
      await unloadProject(project.id);
      return { trusted: false };
    },
  );
};
