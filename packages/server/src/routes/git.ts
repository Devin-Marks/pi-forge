import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  GitCommandError,
  GitNotInstalledError,
  InvalidBranchNameError,
  checkoutBranch,
  commit,
  createBranch,
  deleteBranch,
  fetch,
  addRemote,
  getBranches,
  getRemotes,
  removeRemote,
  setRemoteInsecureTls,
  getDiff,
  getFileDiff,
  getLog,
  getStagedDiff,
  getStatus,
  getWorktrees,
  initRepo,
  isGitRepo,
  pull,
  push,
  revertPaths,
  stagePaths,
  unstagePaths,
} from "../git-runner.js";
import { applyHunks, HunkStagingError } from "../git-hunk-stager.js";
import { config } from "../config.js";
import { PathOutsideRootError } from "../file-manager.js";
import { getProject } from "../project-manager.js";
import { errorSchema } from "./_schemas.js";

/* ----------------------------- schemas ----------------------------- */

const fileStatusEntrySchema = {
  type: "object",
  required: ["path", "staged", "unstaged", "kind", "code"],
  properties: {
    path: { type: "string" },
    staged: { type: "boolean" },
    unstaged: { type: "boolean" },
    kind: {
      type: "string",
      enum: [
        "modified",
        "added",
        "deleted",
        "renamed",
        "copied",
        "untracked",
        "ignored",
        "conflicted",
        "unknown",
      ],
    },
    code: { type: "string" },
    originalPath: { type: "string" },
  },
} as const;

const statusSchema = {
  type: "object",
  required: ["isGitRepo", "files"],
  properties: {
    isGitRepo: { type: "boolean" },
    branch: { type: "string" },
    files: { type: "array", items: fileStatusEntrySchema },
  },
} as const;

const diffSchema = {
  type: "object",
  required: ["isGitRepo", "diff"],
  properties: {
    isGitRepo: { type: "boolean" },
    diff: { type: "string" },
  },
} as const;

const logSchema = {
  type: "object",
  required: ["isGitRepo", "commits"],
  properties: {
    isGitRepo: { type: "boolean" },
    commits: {
      type: "array",
      items: {
        type: "object",
        required: ["hash", "message", "author", "date", "parents", "refs"],
        properties: {
          hash: { type: "string" },
          message: { type: "string" },
          author: { type: "string" },
          date: { type: "string" },
          parents: { type: "array", items: { type: "string" } },
          refs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const branchesSchema = {
  type: "object",
  required: ["isGitRepo", "branches"],
  properties: {
    isGitRepo: { type: "boolean" },
    current: { type: "string" },
    branches: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "current", "remote"],
        properties: {
          name: { type: "string" },
          current: { type: "boolean" },
          remote: { type: "boolean" },
        },
      },
    },
  },
} as const;

const remotesSchema = {
  type: "object",
  required: ["isGitRepo", "remotes"],
  properties: {
    isGitRepo: { type: "boolean" },
    remotes: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "fetchUrl", "pushUrl", "insecureTls"],
        properties: {
          name: { type: "string" },
          fetchUrl: { type: "string" },
          pushUrl: { type: "string" },
          insecureTls: { type: "boolean" },
        },
      },
    },
  },
} as const;

const worktreesSchema = {
  type: "object",
  required: ["isGitRepo", "worktrees"],
  properties: {
    isGitRepo: { type: "boolean" },
    worktrees: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "bare", "detached", "current"],
        properties: {
          path: { type: "string" },
          head: { type: "string" },
          branch: { type: "string" },
          bare: { type: "boolean" },
          detached: { type: "boolean" },
          current: { type: "boolean" },
        },
      },
    },
  },
} as const;

class InvalidWorktreePathError extends Error {
  constructor(path: string) {
    super(`invalid worktree path: ${path}`);
    this.name = "InvalidWorktreePathError";
  }
}

/* ----------------------------- error mapping ----------------------------- */

function mapError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof GitNotInstalledError) {
    return reply.code(500).send({
      error: "git_not_installed",
      message: "git binary is not on PATH on the server",
    });
  }
  if (err instanceof InvalidBranchNameError) {
    return reply.code(400).send({ error: "invalid_branch_name", message: err.message });
  }
  if (err instanceof InvalidWorktreePathError) {
    return reply.code(400).send({ error: "invalid_worktree_path", message: err.message });
  }
  if (err instanceof PathOutsideRootError) {
    return reply.code(403).send({ error: "path_not_allowed", message: "path outside workspace" });
  }
  if (err instanceof GitCommandError) {
    // Git "rejected" / "non-fast-forward" / commit hook failures /
    // missing upstream are user-actionable, not server bugs. 400
    // with a sanitized message lets the client surface the hint
    // verbatim. Auth failures get a stable error code so the UI can
    // distinguish "configure credentials" from ordinary git failures
    // without ever collecting or returning raw secrets.
    return reply.code(400).send({ error: err.errorCode, message: err.userMessage });
  }
  reply.log.error({ err }, "unmapped git-runner error");
  return reply.code(500).send({ error: "internal_error" });
}

/**
 * Resolve the project for a request. On miss, sends 404 + returns
 * undefined; caller MUST `return reply` immediately. Returning bare
 * `undefined` trips Fastify's `FST_ERR_REP_ALREADY_SENT` because the
 * route handler's resolved `undefined` is interpreted as "send this,"
 * which races the 404 the helper already sent. See
 * files.ts:resolveProject for the same contract.
 */
async function resolveProject(
  projectId: string,
  reply: FastifyReply,
): Promise<{ id: string; path: string } | undefined> {
  const project = await getProject(projectId);
  if (project === undefined) {
    await reply.code(404).send({ error: "project_not_found", message: "no project with that id" });
    return undefined;
  }
  return { id: project.id, path: project.path };
}

/**
 * Resolve-then-run helper that collapses the project-not-found 404 +
 * runner-error 4xx mapping every git GET route shares. Without this
 * each route was 6 lines of identical boilerplate (resolveProject,
 * undefined-check, try, runner call, catch, mapError); routes shrink
 * to a one-liner.
 *
 * On project-not-found the resolveProject helper has already sent the
 * 404 reply; we return its `undefined` so the route handler short-
 * circuits without trying to return a value Fastify would re-send.
 * On runner success the result is returned verbatim (Fastify
 * serializes via the response schema). On runner throw we route to
 * mapError for the typed-error → wire-shape mapping.
 */
async function withProject<T>(
  projectId: string,
  reply: FastifyReply,
  fn: (project: { id: string; path: string }) => Promise<T>,
): Promise<T | FastifyReply | undefined> {
  const project = await resolveProject(projectId, reply);
  // resolveProject already called reply.send for the 404 path —
  // returning the reply here tells Fastify the response was handled,
  // avoiding the FST_ERR_REP_ALREADY_SENT double-send error.
  if (project === undefined) return reply;
  try {
    return await fn(project);
  } catch (err) {
    return mapError(reply, err);
  }
}

async function resolveGitCwd(
  project: { path: string },
  worktreePath: string | undefined,
): Promise<string> {
  if (worktreePath === undefined) return project.path;
  const listed = await getWorktrees(project.path);
  const match = listed.worktrees.find((w) => w.path === worktreePath);
  if (match === undefined) throw new InvalidWorktreePathError(worktreePath);
  return match.path;
}

async function withGitCwd<T>(
  projectId: string,
  worktreePath: string | undefined,
  reply: FastifyReply,
  fn: (cwd: string) => Promise<T>,
): Promise<T | FastifyReply | undefined> {
  const project = await resolveProject(projectId, reply);
  if (project === undefined) return reply;
  try {
    const cwd = await resolveGitCwd(project, worktreePath);
    return await fn(cwd);
  } catch (err) {
    return mapError(reply, err);
  }
}

const projectWorktreeQuerySchema = {
  type: "object",
  required: ["projectId"],
  properties: {
    projectId: { type: "string", minLength: 1 },
    worktreePath: { type: "string", minLength: 1 },
  },
} as const;

const worktreeBodyProperty = { worktreePath: { type: "string", minLength: 1 } } as const;

/* ----------------------------- routes ----------------------------- */

export const gitRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { projectId: string } }>(
    "/git/init",
    {
      schema: {
        description:
          "Initialize a fresh git repo at the project's path with `main` as the " +
          "initial branch. Idempotent: returns 200 with `{ alreadyInitialised: " +
          "true }` if the project is already a git working tree. Falls back to " +
          "plain `git init` (no `-b main`) on git versions < 2.28.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["alreadyInitialised", "isGitRepo"],
            properties: {
              alreadyInitialised: { type: "boolean" },
              isGitRepo: { type: "boolean" },
            },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return reply;
      try {
        if (await isGitRepo(project.path)) {
          return { alreadyInitialised: true, isGitRepo: true };
        }
        await initRepo(project.path);
        return { alreadyInitialised: false, isGitRepo: true };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; worktreePath?: string } }>(
    "/git/status",
    {
      // Polled by the client every ~15s while a project is open. We
      // silence the access logs for this route specifically so the
      // poll doesn't drown out interesting events; errors still log
      // at warn+.
      logLevel: "warn",
      schema: {
        description:
          "Parsed `git status --porcelain=v1 -uall` for the project. Files " +
          "include staged/unstaged flags, a coarse `kind` classification, and " +
          "the raw two-char porcelain code. Non-git directories return " +
          "`{ isGitRepo: false, files: [] }` (NOT 500) so the panel can sit " +
          "quiet on plain folders.",
        tags: ["git"],
        querystring: projectWorktreeQuerySchema,
        response: {
          200: statusSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) => getStatus(cwd)),
  );

  fastify.get<{ Querystring: { projectId: string } }>(
    "/git/worktrees",
    {
      schema: {
        description:
          "List registered git worktrees for the project's repository. Returned absolute paths " +
          "can be passed back as `worktreePath` to git routes and are accepted only if still registered.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: {
          200: worktreesSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withProject(req.query.projectId, reply, async (p) => {
        return getWorktrees(p.path);
      }),
  );

  fastify.get<{ Querystring: { projectId: string; worktreePath?: string } }>(
    "/git/diff",
    {
      schema: {
        description: "Unstaged unified diff for the project (working tree vs index).",
        tags: ["git"],
        querystring: projectWorktreeQuerySchema,
        response: {
          200: diffSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) => getDiff(cwd)),
  );

  fastify.get<{ Querystring: { projectId: string; worktreePath?: string } }>(
    "/git/diff/staged",
    {
      schema: {
        description: "Staged unified diff (index vs HEAD).",
        tags: ["git"],
        querystring: projectWorktreeQuerySchema,
        response: {
          200: diffSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) => getStagedDiff(cwd)),
  );

  fastify.get<{
    Querystring: { projectId: string; path: string; staged?: string; worktreePath?: string };
  }>(
    "/git/diff/file",
    {
      schema: {
        description:
          "Unified diff for a single file. `?staged=1` for the index↔HEAD diff; " +
          "default is working-tree↔index.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            staged: { type: "string", enum: ["0", "1", "true", "false"] },
            worktreePath: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: diffSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const staged = req.query.staged === "1" || req.query.staged === "true";
      return withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) =>
        getFileDiff(cwd, req.query.path, staged),
      );
    },
  );

  fastify.get<{ Querystring: { projectId: string; limit?: string; worktreePath?: string } }>(
    "/git/log",
    {
      schema: {
        description:
          "Recent commits as `{ hash, message, author, date }[]`. Default " + "limit 30; max 1000.",
        tags: ["git"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            limit: { type: "string", pattern: "^[0-9]+$" },
            worktreePath: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: logSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const limit =
        req.query.limit !== undefined
          ? Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10)))
          : 30;
      return withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) =>
        getLog(cwd, limit),
      );
    },
  );

  fastify.get<{ Querystring: { projectId: string; worktreePath?: string } }>(
    "/git/branches",
    {
      schema: {
        description: "Local + remote branch list with `current` flag.",
        tags: ["git"],
        querystring: projectWorktreeQuerySchema,
        response: {
          200: branchesSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) => getBranches(cwd)),
  );

  fastify.get<{ Querystring: { projectId: string; worktreePath?: string } }>(
    "/git/remotes",
    {
      schema: {
        description:
          "Configured git remotes with their fetch + push URLs. " +
          "Empty array for non-git projects or repos with no remotes.",
        tags: ["git"],
        querystring: projectWorktreeQuerySchema,
        response: {
          200: remotesSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.query.projectId, req.query.worktreePath, reply, (cwd) => getRemotes(cwd)),
  );

  fastify.post<{
    Body: {
      projectId: string;
      name: string;
      url: string;
      insecureTls?: boolean;
      worktreePath?: string;
    };
  }>(
    "/git/remote/add",
    {
      schema: {
        description:
          "Add a git remote (`git remote add <name> <url>`). Name is " +
          "validated against the same character set as branch names. " +
          "URL accepts any string git itself accepts (https://, git@, " +
          "file://, etc.). Optional `insecureTls: true` persists a local, " +
          "URL-scoped `http.<url>.sslVerify=false` setting for this repo. " +
          "Duplicate name → 400 `git_failed`.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "name", "url"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            url: { type: "string", minLength: 1, maxLength: 1024 },
            insecureTls: { type: "boolean" },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        await addRemote(cwd, req.body.name, req.body.url, {
          insecureTls: req.body.insecureTls === true,
        });
        return { ok: true };
      }),
  );

  fastify.post<{
    Body: { projectId: string; name: string; insecureTls: boolean; worktreePath?: string };
  }>(
    "/git/remote/tls",
    {
      schema: {
        description:
          "Enable or disable TLS certificate verification for one remote in this repository. " +
          "The setting is persisted in local git config as URL-scoped `http.<url>.sslVerify=false`; " +
          "it does not change global git config or store credentials.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "name", "insecureTls"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            insecureTls: { type: "boolean" },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        await setRemoteInsecureTls(cwd, req.body.name, req.body.insecureTls);
        return { ok: true };
      }),
  );

  fastify.delete<{
    Params: { name: string };
    Querystring: { projectId: string; worktreePath?: string };
  }>(
    "/git/remote/:name",
    {
      schema: {
        description:
          "Remove a git remote (`git remote remove <name>`). 400 " +
          "`git_failed` if the name is unknown.",
        tags: ["git"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: projectWorktreeQuerySchema,
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.query.projectId, req.query.worktreePath, reply, async (cwd) => {
        await removeRemote(cwd, req.params.name);
        return { ok: true };
      }),
  );

  fastify.post<{ Body: { projectId: string; branch: string; worktreePath?: string } }>(
    "/git/checkout",
    {
      schema: {
        description:
          "Switch the working tree to `branch`. Refuses on a dirty tree (git's " +
          "default) — caller surfaces the resulting `git_failed` message so the " +
          "user can stash or revert first. Pass `origin/feature` to start a " +
          "tracking branch from the remote ref.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "branch"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        await checkoutBranch(cwd, req.body.branch);
        return { ok: true };
      }),
  );

  fastify.post<{
    Body: {
      projectId: string;
      name: string;
      startPoint?: string;
      checkout?: boolean;
      worktreePath?: string;
    };
  }>(
    "/git/branch/create",
    {
      schema: {
        description:
          "Create a local branch. `startPoint` (defaults to HEAD) accepts any ref " +
          "the user could pass to `git branch`. `checkout: true` creates and " +
          "switches in one step via `git checkout -b`.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "name"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            startPoint: { type: "string", minLength: 1 },
            checkout: { type: "boolean" },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        const opts: { startPoint?: string; checkout?: boolean } = {};
        if (req.body.startPoint !== undefined) opts.startPoint = req.body.startPoint;
        if (req.body.checkout !== undefined) opts.checkout = req.body.checkout;
        await createBranch(cwd, req.body.name, opts);
        return { ok: true };
      }),
  );

  fastify.delete<{
    Querystring: { projectId: string; force?: string; worktreePath?: string };
    Params: { name: string };
  }>(
    "/git/branch/:name",
    {
      schema: {
        description:
          "Delete a local branch via `git branch -d <name>`. `?force=1` switches " +
          "to `-D` for branches that haven't been merged. Refuses to delete the " +
          "currently-checked-out branch (git surfaces a `git_failed`).",
        tags: ["git"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            force: { type: "string", enum: ["0", "1", "true", "false"] },
            worktreePath: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const force = req.query.force === "1" || req.query.force === "true";
      return withGitCwd(req.query.projectId, req.query.worktreePath, reply, async (cwd) => {
        await deleteBranch(cwd, req.params.name, { force });
        return { ok: true };
      });
    },
  );

  fastify.post<{ Body: { projectId: string; paths: string[]; worktreePath?: string } }>(
    "/git/stage",
    {
      schema: {
        description: "Stage one or more files (`git add -- <paths>`).",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "paths"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            paths: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 4096 },
              minItems: 1,
              // Hard cap to keep argv under typical OS limits (~128KB on
              // Linux). Single-tenant + trusted user, so this is mostly
              // a guard against accidental loops or oversized JSON
              // bodies; legitimate stage/unstage/revert operations on
              // even a very wide repo land well under 1000 paths.
              maxItems: 1000,
            },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        await stagePaths(cwd, req.body.paths);
        return { ok: true };
      }),
  );

  fastify.post<{ Body: { projectId: string; paths: string[]; worktreePath?: string } }>(
    "/git/unstage",
    {
      schema: {
        description: "Unstage one or more files (`git restore --staged -- <paths>`).",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "paths"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            paths: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 4096 },
              minItems: 1,
              // Hard cap to keep argv under typical OS limits (~128KB on
              // Linux). Single-tenant + trusted user, so this is mostly
              // a guard against accidental loops or oversized JSON
              // bodies; legitimate stage/unstage/revert operations on
              // even a very wide repo land well under 1000 paths.
              maxItems: 1000,
            },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        await unstagePaths(cwd, req.body.paths);
        return { ok: true };
      }),
  );

  fastify.post<{
    Body: {
      projectId: string;
      path: string;
      mode: "stage" | "unstage";
      hunkIndices: number[];
      worktreePath?: string;
    };
  }>(
    "/git/apply-hunks",
    {
      schema: {
        description:
          "Stage or unstage selected hunks of a single file. Builds a " +
          "synthetic patch from the file's current diff containing only " +
          "the requested hunk indices, then runs " +
          "`git apply --cached --recount [--reverse]` against it. " +
          "Returns `{ ok: false, error }` for git-side failures (binary " +
          "file, no diff on the requested side, conflicting patch, etc.) " +
          "rather than 500 — these are user-visible events.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "path", "mode", "hunkIndices"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1, maxLength: 4096 },
            mode: { type: "string", enum: ["stage", "unstage"] },
            hunkIndices: {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: 10_000 },
              minItems: 1,
              maxItems: 1_000,
            },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: {
              ok: { type: "boolean" },
              error: { type: "string" },
              totalHunks: { type: "integer", minimum: 0 },
            },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        try {
          const { totalHunks } = await applyHunks(
            cwd,
            req.body.path,
            req.body.hunkIndices,
            req.body.mode,
          );
          return { ok: true, totalHunks };
        } catch (err) {
          // HunkStagingError carries a code suitable for the UI to show
          // (binary_or_no_hunks, no_diff, hunk_index_out_of_range,
          // git_apply_failed). Return as ok:false so the panel can render
          // a banner rather than a generic toast.
          if (err instanceof HunkStagingError) {
            return { ok: false, error: err.code, totalHunks: 0 };
          }
          throw err;
        }
      }),
  );

  fastify.post<{ Body: { projectId: string; paths: string[]; worktreePath?: string } }>(
    "/git/revert",
    {
      schema: {
        description:
          "Discard local changes for the given files via `git restore " +
          "--staged --worktree --source=HEAD`. Restores both the index " +
          "and the working tree to HEAD — destructive, the caller is " +
          "expected to gate behind a confirmation. Untracked files " +
          "produce a 400 with git's stderr ('pathspec did not match'); " +
          "delete those via /files/delete instead.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "paths"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            paths: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 4096 },
              minItems: 1,
              // Hard cap to keep argv under typical OS limits (~128KB on
              // Linux). Single-tenant + trusted user, so this is mostly
              // a guard against accidental loops or oversized JSON
              // bodies; legitimate stage/unstage/revert operations on
              // even a very wide repo land well under 1000 paths.
              maxItems: 1000,
            },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        await revertPaths(cwd, req.body.paths);
        return { ok: true };
      }),
  );

  fastify.post<{ Body: { projectId: string; message: string; worktreePath?: string } }>(
    "/git/commit",
    {
      schema: {
        description:
          "Commit the currently-staged changes. Pre-commit hooks fire as " +
          "normal — `--no-verify` is intentionally NOT used so browser " +
          "commits gate the same way terminal commits do.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId", "message"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: {
            type: "object",
            required: ["hash"],
            properties: { hash: { type: "string" } },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const message = req.body.message.trim();
      if (message.length === 0) {
        return reply.code(400).send({ error: "empty_message" });
      }
      return withGitCwd(req.body.projectId, req.body.worktreePath, reply, (cwd) =>
        commit(cwd, message),
      );
    },
  );

  fastify.post<{
    Body: { projectId: string; remote?: string; prune?: boolean; worktreePath?: string };
  }>(
    "/git/fetch",
    {
      schema: {
        description:
          "git fetch — never touches the working tree, safe regardless of " +
          "dirty state. `prune: true` adds --prune so deleted upstream " +
          "branches are removed locally. Returns the captured output.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            remote: { type: "string", minLength: 1 },
            prune: { type: "boolean" },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", required: ["output"], properties: { output: { type: "string" } } },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        const opts: { remote?: string; prune?: boolean } = {};
        if (req.body.remote !== undefined) opts.remote = req.body.remote;
        if (req.body.prune !== undefined) opts.prune = req.body.prune;
        const { stdout } = await fetch(cwd, opts);
        return { output: stdout };
      }),
  );

  fastify.post<{
    Body: {
      projectId: string;
      remote?: string;
      branch?: string;
      rebase?: boolean;
      worktreePath?: string;
    };
  }>(
    "/git/pull",
    {
      schema: {
        description:
          "git pull — fetches AND merges (or rebases with `rebase: true`). " +
          "Conflicts are surfaced verbatim in the 400 message; the user can " +
          "drop to the integrated terminal to resolve. No conflict-resolution " +
          "UI in v1.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            remote: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            rebase: { type: "boolean" },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: { type: "object", required: ["output"], properties: { output: { type: "string" } } },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        const opts: { remote?: string; branch?: string; rebase?: boolean } = {};
        if (req.body.remote !== undefined) opts.remote = req.body.remote;
        if (req.body.branch !== undefined) opts.branch = req.body.branch;
        if (req.body.rebase !== undefined) opts.rebase = req.body.rebase;
        const { stdout } = await pull(cwd, opts);
        return { output: stdout };
      }),
  );

  fastify.post<{
    Body: {
      projectId: string;
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
      worktreePath?: string;
    };
  }>(
    "/git/push",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.pushMax,
          timeWindow: config.rateLimits.pushWindowMs,
        },
      },
      schema: {
        description:
          "Push to a remote. With no `remote`/`branch` body fields, runs " +
          "plain `git push` against the configured upstream. `setUpstream: " +
          "true` adds `--set-upstream` so the remote/branch is recorded as " +
          "the tracking ref (required on first push of a new local branch). " +
          "Returns 400 with a sanitized git failure message. Auth failures use " +
          "error=git_auth_required with guidance to configure credentials outside pi-forge.",
        tags: ["git"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            remote: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            setUpstream: { type: "boolean" },
            ...worktreeBodyProperty,
          },
        },
        response: {
          200: {
            type: "object",
            required: ["output"],
            properties: { output: { type: "string" } },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) =>
      withGitCwd(req.body.projectId, req.body.worktreePath, reply, async (cwd) => {
        const opts: { remote?: string; branch?: string; setUpstream?: boolean } = {};
        if (req.body.remote !== undefined) opts.remote = req.body.remote;
        if (req.body.branch !== undefined) opts.branch = req.body.branch;
        if (req.body.setUpstream !== undefined) opts.setUpstream = req.body.setUpstream;
        const { stdout } = await push(cwd, opts);
        return { output: stdout };
      }),
  );
};
