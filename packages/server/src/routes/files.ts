import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  ChecksumMismatchError,
  DirectoryNotEmptyError,
  FileTooLargeError,
  InvalidNameError,
  NotAFileError,
  NotFoundError,
  PathOutsideRootError,
  TargetExistsError,
  deleteEntry,
  downloadStream,
  getTree,
  listAllFiles,
  makeDirectory,
  moveEntry,
  readFile,
  renameEntry,
  writeFile,
  writeFileBytes,
} from "../file-manager.js";
import { config } from "../config.js";
import { getProject } from "../project-manager.js";
import { searchFiles, SearchEngineUnavailableError } from "../file-searcher.js";
import { errorSchema } from "./_schemas.js";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_UPLOAD_FILES = 16;
// Aggregate cap across all files in a single upload request. The
// per-file cap × file count gives 8 GB of theoretical headroom — the
// aggregate cap puts a tighter ceiling on memory + disk pressure when
// the user picks a folder full of medium files. Tracked in the parts
// loop and surfaced as 413 with `aggregate_too_large` so the UI can
// distinguish from per-file overflows.
const MAX_TOTAL_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

class AggregateLimitError extends Error {
  constructor(limit: number) {
    super(`aggregate upload exceeds ${limit} bytes`);
    this.name = "AggregateLimitError";
  }
}

/**
 * Wrap a multipart file stream so the running byte total is checked
 * against {@link MAX_TOTAL_UPLOAD_BYTES} on every chunk. Throws
 * {@link AggregateLimitError} the moment the aggregate crosses the
 * cap; writeFileBytes catches the throw, unlinks its tmp file, and
 * the route handler maps it to 413. We pass the running counter via
 * getter/setter so the count is shared across files in the same
 * request without leaking module state.
 */
function trackAggregate(
  source: AsyncIterable<Buffer | Uint8Array>,
  getTotal: () => number,
  setTotal: (n: number) => void,
): AsyncIterable<Buffer | Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        const next = getTotal() + chunk.byteLength;
        if (next > MAX_TOTAL_UPLOAD_BYTES) {
          throw new AggregateLimitError(MAX_TOTAL_UPLOAD_BYTES);
        }
        setTotal(next);
        yield chunk;
      }
    },
  };
}

/* ----------------------------- schemas ----------------------------- */

// `additionalProperties: true` on the recursive `children` so Fastify's
// serializer doesn't drop fields if we add new ones in a future SDK
// release.
const treeNodeSchema = {
  type: "object",
  required: ["name", "path", "type"],
  additionalProperties: true,
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    type: { type: "string", enum: ["file", "directory"] },
    children: { type: "array", items: { type: "object", additionalProperties: true } },
    truncated: { type: "boolean" },
  },
} as const;

const readResponseSchema = {
  type: "object",
  required: ["path", "content", "size", "language", "binary"],
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    size: { type: "integer", minimum: 0 },
    language: { type: "string" },
    binary: { type: "boolean" },
  },
} as const;

/* ----------------------------- helpers ----------------------------- */

/**
 * Parse + clamp the `limit` query param (string-typed because Fastify
 * deserializes querystrings as strings). Defaults to 50, caps at 200.
 * Used by the `@`-completion endpoint where unbounded results would
 * blow up the popover render.
 */
function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

/* ----------------------------- error mapping ----------------------------- */

/**
 * Translate file-manager errors into wire-shape responses. Routes funnel
 * everything through this so the mapping is centralised — a future error
 * type lands in one place.
 */
function mapError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PathOutsideRootError) {
    return reply
      .code(403)
      .send({ error: "path_not_allowed", message: "path is outside the project root" });
  }
  if (err instanceof InvalidNameError) {
    return reply.code(400).send({ error: "invalid_name", message: err.message });
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: "not_found", message: "file or directory not found" });
  }
  if (err instanceof NotAFileError) {
    return reply.code(400).send({ error: "not_a_file", message: "target is not a regular file" });
  }
  if (err instanceof FileTooLargeError) {
    return reply.code(413).send({ error: "file_too_large", message: `${err.size} > ${err.limit}` });
  }
  if (err instanceof DirectoryNotEmptyError) {
    return reply.code(409).send({
      error: "directory_not_empty",
      message: "delete the contents first; recursive delete is not supported",
    });
  }
  if (err instanceof TargetExistsError) {
    return reply.code(409).send({ error: "target_exists", message: "destination already exists" });
  }
  if (err instanceof ChecksumMismatchError) {
    return reply.code(422).send({
      error: "checksum_mismatch",
      message: `expected sha256 ${err.expected}, computed ${err.actual}`,
    });
  }
  if (err instanceof SearchEngineUnavailableError) {
    return reply.code(503).send({ error: "engine_unavailable", message: err.message });
  }
  // Raw NodeJS.ErrnoException fallback. Without this, an EACCES on a
  // perms-restricted file in the project tree, an EISDIR from trying to
  // read a directory as a file, or a vanished file (ENOENT) all collapsed
  // to a generic 500 — the user got no actionable diagnostic and the
  // operator had to grep logs to figure out what happened.
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return reply.code(404).send({ error: "not_found", message: "file or directory not found" });
  }
  if (code === "EACCES" || code === "EPERM") {
    return reply
      .code(403)
      .send({ error: "permission_denied", message: "filesystem permission denied" });
  }
  if (code === "EISDIR") {
    return reply
      .code(400)
      .send({ error: "not_a_file", message: "target is a directory, not a file" });
  }
  if (code === "ENOTDIR") {
    return reply
      .code(400)
      .send({ error: "not_a_directory", message: "target is a file, not a directory" });
  }
  reply.log.error({ err }, "unmapped file-manager error");
  return reply.code(500).send({ error: "internal_error" });
}

/**
 * Resolve the project for a request and short-circuit with 404 when it
 * doesn't exist. Returns the project on success; the route handler should
 * return immediately if `undefined` comes back.
 */
/**
 * Resolve the project for a request.
 *
 * Contract: returns the project on success. On miss, sends a 404
 * via `reply` AND returns undefined — caller MUST `if (project ===
 * undefined) return reply;` immediately. Returning bare `undefined`
 * trips Fastify's `FST_ERR_REP_ALREADY_SENT` because the handler's
 * resolved value is interpreted as "send this," racing the 404 the
 * helper already sent. The 404 response is intentionally awaited
 * (Fastify reply.send returns the reply object; awaiting it ensures
 * any onSend hooks have run before the route handler proceeds).
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

/* ----------------------------- routes ----------------------------- */

export const fileRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- @-completion (chat input file references) ----
  // Polled on every keystroke inside an `@<query>` token; results
  // shown in a popover above the input. Returns up to 50 paths
  // matching the query as a path-substring; ranked so a basename
  // hit beats a deep-path hit.
  fastify.get<{ Querystring: { projectId: string; query?: string; limit?: string } }>(
    "/files/complete",
    {
      // Polled per keystroke — silence access logs to keep the
      // stream readable. Errors still log at warn+.
      logLevel: "warn",
      schema: {
        description:
          "Flat list of project files matching `query` (path-substring, " +
          "case-insensitive). Used by the chat input's `@` autocomplete. " +
          "Skips the same noisy directories as /files/tree. Returns up to " +
          "`limit` (default 50) POSIX-style paths relative to the project " +
          "root, ranked so a basename match beats a deep-path match and " +
          "shorter paths beat longer ones.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            query: { type: "string", maxLength: 256 },
            limit: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["paths"],
            properties: { paths: { type: "array", items: { type: "string" } } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const query = (req.query.query ?? "").toLowerCase();
      const limit = clampLimit(req.query.limit);
      try {
        const all = await listAllFiles(project.path);
        if (query.length === 0) {
          // Empty query — return the first `limit` files (alphabetically),
          // matches editor "Quick Open"-style empty-state behaviour.
          return { paths: all.sort().slice(0, limit) };
        }
        // Score each path: basename match outranks path-substring match;
        // basename startsWith outranks basename includes; shorter wins
        // ties. Cheap and predictable.
        interface Scored {
          path: string;
          score: number;
        }
        const scored: Scored[] = [];
        for (const p of all) {
          const lower = p.toLowerCase();
          const slash = lower.lastIndexOf("/");
          const base = slash === -1 ? lower : lower.slice(slash + 1);
          let score: number;
          if (base === query) score = 0;
          else if (base.startsWith(query)) score = 1;
          else if (base.includes(query)) score = 2;
          else if (lower.includes(query)) score = 3;
          else continue;
          scored.push({ path: p, score });
        }
        scored.sort((a, b) =>
          a.score !== b.score ? a.score - b.score : a.path.length - b.path.length,
        );
        return { paths: scored.slice(0, limit).map((s) => s.path) };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; maxDepth?: string } }>(
    "/files/tree",
    {
      schema: {
        description:
          "Recursive directory tree for the project. Skips noisy folders " +
          "(node_modules, .git, dist, build, __pycache__, .next, .nuxt, " +
          "coverage, .vite, .turbo, .cache). Default max depth 6 — deeper " +
          "directories are returned with `truncated: true` so the UI can " +
          "lazy-fetch them on demand.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            maxDepth: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: { 200: treeNodeSchema, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return reply;
      try {
        // Clamp client-supplied maxDepth to a sane window. The schema
        // already gates on `^[0-9]+$`, so parseInt is safe; we cap at
        // 32 because anything past that is either a misconfiguration
        // or someone trying to force a deep recursion DoS.
        let maxDepth: number | undefined;
        if (req.query.maxDepth !== undefined) {
          const n = Number.parseInt(req.query.maxDepth, 10);
          maxDepth = Math.min(Math.max(n, 1), 32);
        }
        const tree = await getTree(project.path, maxDepth !== undefined ? { maxDepth } : {});
        return tree;
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; path?: string } }>(
    "/files/download",
    {
      schema: {
        description:
          "Download a file or directory from the project. Files stream " +
          "verbatim with `Content-Disposition: attachment`; directories " +
          "stream as a gzipped tar (`<dir>.tar.gz`) with the same exclusions " +
          "as the file tree (node_modules, .git, dist, build, etc.). Omitting " +
          "`path` downloads the whole project as a tar.gz.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
          },
        },
        response: {
          // Binary stream — OpenAPI describes it as `string` + `format: binary`.
          200: { type: "string", format: "binary" },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return reply;
      const target = req.query.path ?? project.path;
      try {
        const result = await downloadStream(target, project.path);
        // RFC 5987 filename* = UTF-8 + percent-encoded so non-ASCII
        // names survive Chrome / Firefox / Safari. Keep the legacy
        // `filename=` for older clients with the same name ASCII-
        // sanitised — most filenames are ASCII anyway.
        const asciiName = result.filename.replace(/[^\x20-\x7e]/g, "_");
        const utfName = encodeURIComponent(result.filename);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${asciiName}"; filename*=UTF-8''${utfName}`,
        );
        if (result.kind === "file") {
          reply.header("Content-Type", "application/octet-stream");
          reply.header("Content-Length", String(result.size));
        } else {
          reply.header("Content-Type", "application/gzip");
          // No Content-Length — we don't know the gzipped size up front.
        }
        return reply.send(result.stream);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId: string; path: string } }>(
    "/files/read",
    {
      schema: {
        description:
          "Read a UTF-8 file from the project. 5 MB cap (returns 413). " +
          "Binary files return `{ binary: true, content: '' }` rather than a " +
          "garbled UTF-8 decode — clients should not pass binary content " +
          "to the editor.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: readResponseSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          413: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return reply;
      try {
        const result = await readFile(req.query.path, project.path);
        return result;
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.put<{ Body: { projectId: string; path: string; content: string } }>(
    "/files/write",
    {
      schema: {
        description:
          "Atomic write (tmp + rename). Creates parent directories as " +
          "needed. The body's `path` is required to be inside the project " +
          "root — 403 otherwise.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "path", "content"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            content: { type: "string" },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return reply;
      try {
        await writeFile(req.body.path, project.path, req.body.content);
        return { path: req.body.path };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; parentPath: string; name: string } }>(
    "/files/mkdir",
    {
      schema: {
        description: "Create a single directory under `parentPath`.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "parentPath", "name"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            parentPath: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return reply;
      try {
        const created = await makeDirectory(req.body.parentPath, project.path, req.body.name);
        return { path: created };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; path: string; name: string } }>(
    "/files/rename",
    {
      schema: {
        description:
          "Rename a file or directory in place — `name` is the new basename. " +
          "Use /files/move to relocate across directories.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "path", "name"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return reply;
      try {
        const renamed = await renameEntry(req.body.path, project.path, req.body.name);
        return { path: renamed };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.post<{ Body: { projectId: string; src: string; dest: string } }>(
    "/files/move",
    {
      schema: {
        description:
          "Move a file or directory to `dest` (a full destination path). " +
          "Refuses to move a directory under itself; refuses if `dest` " +
          "already exists.",
        tags: ["files"],
        body: {
          type: "object",
          required: ["projectId", "src", "dest"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
            src: { type: "string", minLength: 1 },
            dest: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.body.projectId, reply);
      if (project === undefined) return reply;
      try {
        const moved = await moveEntry(req.body.src, req.body.dest, project.path);
        return { path: moved };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.delete<{ Querystring: { projectId: string; path: string; recursive?: string } }>(
    "/files/delete",
    {
      schema: {
        description:
          "Delete a file or directory. Empty directories delete unconditionally. " +
          "Non-empty directories return 409 unless `?recursive=true` is set, in " +
          "which case the entire subtree is removed. The UI prompts the user with " +
          "a second confirmation before retrying with the recursive flag — single- " +
          "user single-tenant, but `rm -rf` should still be an explicit choice.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId", "path"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            recursive: { type: "string", enum: ["true", "false"] },
          },
        },
        response: {
          204: { type: "null" },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return reply;
      try {
        const recursive = req.query.recursive === "true";
        await deleteEntry(req.query.path, project.path, { recursive });
        return reply.code(204).send();
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  fastify.get<{
    Querystring: {
      projectId: string;
      q: string;
      regex?: string;
      caseSensitive?: string;
      includeGitignored?: string;
      include?: string;
      exclude?: string;
      limit?: string;
    };
  }>(
    "/files/search",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.searchMax,
          timeWindow: config.rateLimits.searchWindowMs,
        },
      },
      schema: {
        description:
          "Cross-project text + regex search. Uses ripgrep when available " +
          "(fast + gitignore-aware) and falls back to a Node walk on hosts " +
          "without rg. Response includes `engine: 'ripgrep' | 'node'` so the " +
          "UI can render a fallback-mode badge. Hard caps: 1000 matches max " +
          "per request, 30s wall clock, 5 MB per file. Binary files are " +
          "skipped via NUL-byte heuristic on the fallback path; ripgrep " +
          "uses its own (better) binary detection.",
        tags: ["files"],
        querystring: {
          type: "object",
          required: ["projectId", "q"],
          properties: {
            projectId: { type: "string", minLength: 1 },
            q: { type: "string", minLength: 1, maxLength: 1024 },
            regex: { type: "string", enum: ["0", "1", "true", "false"] },
            caseSensitive: { type: "string", enum: ["0", "1", "true", "false"] },
            includeGitignored: { type: "string", enum: ["0", "1", "true", "false"] },
            include: { type: "string", maxLength: 256 },
            exclude: { type: "string", maxLength: 256 },
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["engine", "matches", "truncated"],
            properties: {
              engine: { type: "string", enum: ["ripgrep", "node"] },
              truncated: { type: "boolean" },
              matches: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path", "line", "column", "length", "lineSnippet"],
                  properties: {
                    path: { type: "string" },
                    line: { type: "integer", minimum: 1 },
                    column: { type: "integer", minimum: 1 },
                    length: { type: "integer", minimum: 0 },
                    lineSnippet: { type: "string" },
                  },
                },
              },
            },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await resolveProject(req.query.projectId, reply);
      if (project === undefined) return reply;
      const { q } = req.query;
      const regex = req.query.regex === "1" || req.query.regex === "true";
      const caseSensitive = req.query.caseSensitive === "1" || req.query.caseSensitive === "true";
      const includeGitignored =
        req.query.includeGitignored === "1" || req.query.includeGitignored === "true";
      const limit =
        req.query.limit !== undefined
          ? Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10)))
          : 200;
      try {
        const opts: Parameters<typeof searchFiles>[1] = {
          query: q,
          regex,
          caseSensitive,
          includeGitignored,
          limit,
          timeoutMs: 30_000,
        };
        if (req.query.include !== undefined && req.query.include.length > 0) {
          opts.include = req.query.include;
        }
        if (req.query.exclude !== undefined && req.query.exclude.length > 0) {
          opts.exclude = req.query.exclude;
        }
        const result = await searchFiles(project.path, opts);
        return result;
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // ----------------------------- upload -----------------------------
  // Multipart upload of one or more files into a chosen folder under
  // the project. Each file is streamed to a tmp path, hashed with
  // SHA-256 as bytes flow, and atomically renamed into place IFF the
  // computed digest matches the one the client supplied (or the client
  // declined to supply one — we still return the computed value so the
  // caller can verify out-of-band). Per-file cap and file-count cap
  // are enforced via the per-call multipart `limits` override.
  //
  // Field shape (FormData order matters — fields BEFORE files so we
  // know `parentPath`/`overwrite`/`sha256:<name>` by the time the file
  // part is parsed):
  //   - projectId: string (required)
  //   - parentPath: string — absolute, inside project (required)
  //   - overwrite: "1"/"true" — replace existing files
  //   - sha256:<filename>: 64-char lowercase hex (optional, per file)
  //   - <any-field-name>: file part(s)
  fastify.post<{
    Body: unknown;
  }>(
    "/files/upload",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.uploadMax,
          timeWindow: config.rateLimits.uploadWindowMs,
        },
      },
      schema: {
        description:
          `Upload one or more files into a project folder via multipart/form-data. ` +
          `Each file is streamed to disk, its SHA-256 is computed on the fly, and ` +
          `the rename to the final name is performed only after a checksum match ` +
          `(when the client supplied one via the \`sha256:<filename>\` text field). ` +
          `Per-file cap: ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Aggregate cap: ` +
          `${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)} MB across all parts. Max ` +
          `${MAX_UPLOAD_FILES} files per request. Existing targets return 409 unless ` +
          `\`overwrite=1\` is sent. Per-file overflows return 413 \`file_too_large\`; ` +
          `aggregate overflows return 413 \`aggregate_too_large\`.`,
        tags: ["files"],
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            required: ["files"],
            properties: {
              files: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path", "size", "sha256"],
                  properties: {
                    path: { type: "string" },
                    size: { type: "integer", minimum: 0 },
                    sha256: { type: "string" },
                  },
                },
              },
            },
          },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          413: errorSchema,
          415: errorSchema,
          422: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply.code(415).send({ error: "expected_multipart" });
      }
      let projectId: string | undefined;
      let parentPath: string | undefined;
      let overwrite = false;
      let aggregateBytes = 0;
      const expectedHashes = new Map<string, string>();
      const written: { path: string; size: number; sha256: string }[] = [];
      try {
        const parts = req.parts({
          limits: {
            fileSize: MAX_UPLOAD_BYTES,
            files: MAX_UPLOAD_FILES,
            fields: 64,
          },
        });
        for await (const part of parts) {
          if (part.type === "field") {
            if (part.fieldname === "projectId" && typeof part.value === "string") {
              projectId = part.value;
            } else if (part.fieldname === "parentPath" && typeof part.value === "string") {
              parentPath = part.value;
            } else if (part.fieldname === "overwrite" && typeof part.value === "string") {
              overwrite = part.value === "1" || part.value === "true";
            } else if (part.fieldname.startsWith("sha256:") && typeof part.value === "string") {
              const name = part.fieldname.slice("sha256:".length);
              if (name.length > 0) expectedHashes.set(name, part.value.toLowerCase());
            }
            continue;
          }
          // File part. Project + parent must already be parsed — the
          // FormData field-order contract is documented above.
          const file = part;
          if (projectId === undefined) {
            return reply.code(400).send({
              error: "missing_field",
              message: "projectId must precede file parts in the multipart body",
            });
          }
          if (parentPath === undefined) {
            return reply.code(400).send({
              error: "missing_field",
              message: "parentPath must precede file parts in the multipart body",
            });
          }
          const project = await getProject(projectId);
          if (project === undefined) {
            return reply.code(404).send({ error: "project_not_found" });
          }
          const filename = file.filename;
          if (filename === undefined || filename.length === 0) {
            return reply.code(400).send({ error: "missing_filename" });
          }
          const expected = expectedHashes.get(filename);
          // Stream the part body straight through writeFileBytes so we
          // never buffer the whole file in memory. We wrap the part
          // stream in an aggregate-tracking iterator so the request
          // aborts as soon as the running total crosses
          // MAX_TOTAL_UPLOAD_BYTES — without this, a user could send
          // 16 × 500 MB and burn 8 GB of disk before the route layer
          // noticed.
          const trackedSource = trackAggregate(
            file.file,
            () => aggregateBytes,
            (n) => {
              aggregateBytes = n;
            },
          );
          let result;
          try {
            result = await writeFileBytes(parentPath, filename, project.path, trackedSource, {
              ...(expected !== undefined ? { expectedSha256: expected } : {}),
              overwrite,
            });
          } catch (err) {
            if (err instanceof AggregateLimitError) {
              // Roll back every previously-written file in this same
              // request. Without this, a 3-file upload where the 3rd
              // trips the aggregate cap would leave the first two on
              // disk; the user sees a 413 and (reasonably) thinks
              // nothing was uploaded, then retries and gets confusing
              // 409 target_exists for the first two.
              for (const prior of written) {
                await deleteEntry(prior.path, project.path).catch(() => undefined);
              }
              return reply.code(413).send({
                error: "aggregate_too_large",
                message: `Total upload size exceeds the ${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)} MB aggregate limit.`,
              });
            }
            throw err;
          }
          if (file.file.truncated) {
            // The file exceeded the per-file cap; writeFileBytes already
            // wrote whatever streamed through. Roll it back so we don't
            // leave a partial upload visible.
            await deleteEntry(result.path, project.path).catch(() => undefined);
            return reply.code(413).send({
              error: "file_too_large",
              message: `Upload "${filename}" exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB per-file limit.`,
            });
          }
          written.push({
            path: result.path,
            size: result.size,
            sha256: result.sha256,
          });
        }
        if (written.length === 0) {
          return reply
            .code(400)
            .send({ error: "no_files", message: "no file parts in the request" });
        }
        return { files: written };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );
};
